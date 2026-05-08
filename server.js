// ════════════════════════════════════════════════════════════════
//  SERVEUR DE PUBLICATION TIKTOK AUTOMATIQUE
//  Déploie sur Railway (railway.app) — gratuit
//  Robot #5 envoie les vidéos + planning → ce serveur publie
// ════════════════════════════════════════════════════════════════

const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const fetch    = require('node-fetch');
const fs       = require('fs');
const path     = require('path');
const cron     = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Stockage des vidéos uploadées
const upload = multer({
  dest: '/tmp/videos/',
  limits: { fileSize: 200 * 1024 * 1024 } // 200 Mo max
});

// ── État en mémoire ──────────────────────────────────────────
// { filename → { titre, caption, hashtags, scheduledAt, status, tiktokPublishId, error } }
let publishQueue = {};
let accessToken  = '';
let clientKey    = '';
let clientSecret = '';

// ── Timers actifs ────────────────────────────────────────────
let activeTimers = {};

// ════════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════════

// Ping — vérifier que le serveur tourne
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'TikTok Publisher Server',
    version: '1.0.0',
    queue: Object.keys(publishQueue).length
  });
});

// Configurer le token TikTok
app.post('/configure', (req, res) => {
  const { token, client_key, client_secret } = req.body;
  if (!token) return res.status(400).json({ error: 'token requis' });
  accessToken  = token;
  clientKey    = client_key    || clientKey;
  clientSecret = client_secret || clientSecret;
  console.log('[Config] Token TikTok reçu');
  res.json({ ok: true, message: 'Token configuré' });
});

// Uploader une vidéo + planifier sa publication
app.post('/schedule', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier vidéo requis' });

  const { titre, caption, hashtags, scheduled_at } = req.body;
  const filename   = req.file.originalname || req.file.filename;
  const filePath   = req.file.path;
  const scheduledAt = scheduled_at ? new Date(scheduled_at) : null;

  publishQueue[filename] = {
    titre,
    caption,
    hashtags:    hashtags ? JSON.parse(hashtags) : [],
    scheduledAt,
    filePath,
    fileSize:    req.file.size,
    status:      scheduledAt && scheduledAt > new Date() ? 'scheduled' : 'pending',
    addedAt:     new Date().toISOString(),
    error:       null,
    tiktokPublishId: null,
  };

  console.log(`[Schedule] ${titre} → ${scheduledAt ? scheduledAt.toLocaleString('fr-FR') : 'immédiat'}`);

  // Planifier la publication
  if (scheduledAt && scheduledAt > new Date()) {
    const delay = scheduledAt.getTime() - Date.now();
    activeTimers[filename] = setTimeout(async () => {
      await publierVideo(filename);
    }, delay);
    console.log(`[Timer] ${titre} dans ${Math.round(delay / 60000)} min`);
  } else {
    // Publier immédiatement
    setImmediate(() => publierVideo(filename));
  }

  res.json({
    ok: true,
    filename,
    scheduledAt,
    status: publishQueue[filename].status
  });
});

// Statut de toutes les vidéos
app.get('/status', (req, res) => {
  const result = {};
  for (const [key, val] of Object.entries(publishQueue)) {
    result[key] = {
      titre:       val.titre,
      status:      val.status,
      scheduledAt: val.scheduledAt,
      error:       val.error,
      publishId:   val.tiktokPublishId,
    };
  }
  res.json({ ok: true, queue: result, token_set: !!accessToken });
});

// Statut d'une vidéo spécifique
app.get('/status/:filename', (req, res) => {
  const v = publishQueue[req.params.filename];
  if (!v) return res.status(404).json({ error: 'Vidéo non trouvée' });
  res.json({ ok: true, ...v, filePath: undefined });
});

// Annuler une vidéo planifiée
app.delete('/cancel/:filename', (req, res) => {
  const fn = req.params.filename;
  if (activeTimers[fn]) {
    clearTimeout(activeTimers[fn]);
    delete activeTimers[fn];
  }
  if (publishQueue[fn]) {
    publishQueue[fn].status = 'cancelled';
  }
  res.json({ ok: true, message: 'Planification annulée' });
});

// Rafraîchir le token OAuth (refresh_token)
app.post('/refresh-token', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token || !clientKey || !clientSecret) {
    return res.status(400).json({ error: 'refresh_token, client_key et client_secret requis' });
  }
  try {
    const r = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key:    clientKey,
        client_secret: clientSecret,
        grant_type:    'refresh_token',
        refresh_token,
      })
    });
    const data = await r.json();
    if (data.access_token) {
      accessToken = data.access_token;
      console.log('[Token] Refreshed OK');
      res.json({ ok: true, expires_in: data.expires_in });
    } else {
      res.status(400).json({ error: data.message || 'Refresh échoué' });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  PUBLICATION TIKTOK
// ════════════════════════════════════════════════════════════════

async function publierVideo(filename) {
  const v = publishQueue[filename];
  if (!v) return;
  if (!accessToken) {
    v.status = 'error';
    v.error  = 'Token TikTok non configuré';
    console.error(`[Error] ${filename}: token manquant`);
    return;
  }

  v.status = 'uploading';
  console.log(`[Publish] Démarrage : ${v.titre}`);

  try {
    // Lire le fichier vidéo
    const fileBuffer = fs.readFileSync(v.filePath);
    const fileSize   = fileBuffer.length;
    const caption    = buildCaption(v);

    // 1. Initialiser l'upload
    const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type':  'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        post_info: {
          title:           caption.slice(0, 150),
          privacy_level:   'SELF_ONLY',
          disable_duet:    false,
          disable_comment: false,
          disable_stitch:  false,
        },
        source_info: {
          source:             'FILE_UPLOAD',
          video_size:         fileSize,
          chunk_size:         fileSize,
          total_chunk_count:  1,
        }
      })
    });

    const initData = await initRes.json();
    console.log(`[Init] ${filename}:`, JSON.stringify(initData).slice(0, 200));

    if (!initData?.data?.publish_id || !initData?.data?.upload_url) {
      throw new Error('Init échoué : ' + JSON.stringify(initData?.error || initData));
    }

    const { publish_id, upload_url } = initData.data;
    v.tiktokPublishId = publish_id;

    // 2. Uploader le fichier (chunk unique)
    const uploadRes = await fetch(upload_url, {
      method:  'PUT',
      headers: {
        'Content-Type':   'video/webm',
        'Content-Range':  `bytes 0-${fileSize - 1}/${fileSize}`,
        'Content-Length': String(fileSize),
      },
      body: fileBuffer,
    });

    if (!uploadRes.ok && uploadRes.status !== 206) {
      throw new Error(`Upload échoué : HTTP ${uploadRes.status}`);
    }

    console.log(`[Upload] ${filename} : OK`);

    // 3. Vérifier le statut
    v.status = 'processing';
    let published = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      await sleep(5000);
      const statusRes = await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
        method:  'POST',
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'Content-Type':  'application/json; charset=UTF-8'
        },
        body: JSON.stringify({ publish_id })
      });
      const statusData = await statusRes.json();
      const status     = statusData?.data?.status;
      console.log(`[Status] ${filename} tentative ${attempt + 1}: ${status}`);

      if (status === 'PUBLISH_COMPLETE' || status === 'SEND_TO_USER_INBOX') {
        published = true;
        break;
      }
      if (status === 'FAILED') {
        throw new Error('TikTok a refusé la vidéo : ' + JSON.stringify(statusData?.data));
      }
    }

    if (published) {
      v.status     = 'published';
      v.publishedAt = new Date().toISOString();
      console.log(`[✅ Publié] ${v.titre}`);
      // Nettoyer le fichier temporaire
      try { fs.unlinkSync(v.filePath); } catch(e) {}
    } else {
      throw new Error('Délai de traitement TikTok dépassé');
    }

  } catch(e) {
    v.status = 'error';
    v.error  = e.message;
    console.error(`[❌ Erreur] ${v.titre} : ${e.message}`);
  }
}

function buildCaption(v) {
  const tags = (v.hashtags || []).map(h => '#' + h.replace('#', '')).join(' ');
  return ((v.caption || v.titre || '').slice(0, 200) + (tags ? '\n\n' + tags : '')).trim();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Vérification périodique des timers manqués (toutes les minutes) ──────────
cron.schedule('* * * * *', () => {
  const now = Date.now();
  for (const [filename, v] of Object.entries(publishQueue)) {
    if (v.status === 'scheduled' && v.scheduledAt && new Date(v.scheduledAt).getTime() <= now) {
      console.log(`[Cron] Heure atteinte pour : ${v.titre}`);
      v.status = 'pending';
      publierVideo(filename);
    }
  }
});

// ── Démarrage ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 TikTok Publisher Server démarré sur le port ${PORT}`);
  console.log(`   Endpoint : http://localhost:${PORT}`);
  console.log(`   Prêt à recevoir les vidéos de Robot #5\n`);
});
