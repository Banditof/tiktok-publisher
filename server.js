// ════════════════════════════════════════════════════════════════
//  TIKTOK AGENT SUITE v3 — 5 AGENTS ENTIÈREMENT AUTONOMES
//  Aucune intervention humaine requise
//
//  Agent 1 : Veille     → analyse tendances, adapte la stratégie
//  Agent 2 : Contenu    → génère les scripts (Claude API)
//  Agent 3 : Voix       → génère les voix-off (ElevenLabs API)
//  Agent 4 : Montage    → génère images IA + assemble la vidéo (FFmpeg)
//  Agent 5 : Publication → publie sur TikTok aux meilleurs horaires
//
//  Communication : bus de messages interne
//  Orchestration : cycle automatique toutes les heures (cron)
// ════════════════════════════════════════════════════════════════

const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const fetch    = require('node-fetch');
const fs       = require('fs');
const path     = require('path');
const cron     = require('node-cron');
// FFmpeg — chargement optionnel (Railway peut ne pas l'avoir)
let ffmpeg = null;
try {
  ffmpeg = require('fluent-ffmpeg');
  const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
  ffmpeg.setFfmpegPath(ffmpegInstaller.path);
  // Tenter de configurer ffprobe
  try {
    const probePath = ffmpegInstaller.path.replace(/ffmpeg([^/\\]*)$/, 'ffprobe$1');
    if (fs.existsSync(probePath)) ffmpeg.setFfprobePath(probePath);
  } catch(e) {}
  console.log('[FFmpeg] Disponible:', ffmpegInstaller.path);
} catch(e) {
  console.warn('[FFmpeg] Non disponible — Agent Montage utilisera un fallback léger');
  ffmpeg = null;
}

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: '10mb' }));
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 200*1024*1024 } });

// Dossiers de travail
['/tmp/audio', '/tmp/images', '/tmp/videos', '/tmp/segments'].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ════════════════════════════════════════════════════════════════
//  ÉTAT GLOBAL
// ════════════════════════════════════════════════════════════════
const STATE = {
  // Credentials
  creds: { tiktok: '', anthropic: '', elevenlabs: '', voiceId: 'pNInz6obpgDQGcFmaJgB' },

  // Stratégie (mise à jour par Agent Veille via signaux Analytics)
  strategy: {
    niche: 'Storytelling', ton: 'Dramatique',
    postingFrequency: 1, bestHours: [8, 19, 21],
    topHashtags: [], visualStyle: 'cinematique', lastUpdated: null,
  },

  // Pipeline de contenu : scripts → audio → vidéo → publication
  scripts:      [],  // { id, titre, corps, accroche, cta, hashtags, conseil_visuel, status, ... }
  audioFiles:   [],  // { scriptId, filename, path, duration }
  videoFiles:   [],  // { scriptId, filename, path, duration, size }
  publishQueue: {},  // { filename → { titre, status, scheduledAt, ... } }

  // Analytics
  analytics: { videos: [], avgViews: 0, engRate: 0, lastFetched: null, topPerformer: null },

  // Agents
  agents: {
    veille:    { status: 'idle', lastRun: null, cycleCount: 0, lastAction: '' },
    contenu:   { status: 'idle', lastRun: null, cycleCount: 0, lastAction: '' },
    voix:      { status: 'idle', lastRun: null, cycleCount: 0, lastAction: '' },
    montage:   { status: 'idle', lastRun: null, cycleCount: 0, lastAction: '' },
    pub:       { status: 'idle', lastRun: null, cycleCount: 0, lastAction: '' },
    analytics: { status: 'idle', lastRun: null, cycleCount: 0, lastAction: '' },
  },

  messageBus: [], alerts: [], actionLog: [],
};

// ════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════
function msg(from, to, type, data, priority = 'normal') {
  const m = { id: `${Date.now()}_${Math.random().toString(36).slice(2,6)}`, from, to, type, data, priority, timestamp: new Date().toISOString(), read: false };
  STATE.messageBus.unshift(m);
  if (STATE.messageBus.length > 150) STATE.messageBus = STATE.messageBus.slice(0, 150);
  return m;
}
function getMsgs(agent, unread = false) {
  return STATE.messageBus.filter(m => (m.to === agent || m.to === 'all') && (!unread || !m.read));
}
function markRead(agent) { STATE.messageBus.forEach(m => { if (m.to === agent || m.to === 'all') m.read = true; }); }

function log(agent, action, level = 'info') {
  const e = { timestamp: new Date().toISOString(), agent, action, level };
  STATE.actionLog.unshift(e);
  if (STATE.actionLog.length > 500) STATE.actionLog = STATE.actionLog.slice(0, 500);
  STATE.agents[agent] && (STATE.agents[agent].lastAction = action);
  console.log(`[${agent.toUpperCase()}] ${action}`);
}
function alert(type, message, agent) {
  STATE.alerts.unshift({ id: Date.now(), type, message, agent, timestamp: new Date().toISOString(), resolved: false });
  if (STATE.alerts.length > 50) STATE.alerts = STATE.alerts.slice(0, 50);
  log('system', `⚠ ALERTE (${type}): ${message}`, 'warn');
}
function setAgent(name, status, extra = {}) {
  STATE.agents[name] = { ...STATE.agents[name], status, ...extra };
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function formatBytes(b) { return b > 1024*1024 ? (b/1024/1024).toFixed(1)+'Mo' : (b/1024).toFixed(0)+'Ko'; }

// ════════════════════════════════════════════════════════════════
//  AGENT ANALYTICS
// ════════════════════════════════════════════════════════════════
async function runAnalytics() {
  if (!STATE.creds.tiktok) return;
  setAgent('analytics', 'running');
  log('analytics', 'Récupération stats TikTok');
  try {
    const res  = await fetch('https://open.tiktokapis.com/v2/video/list/?fields=id,title,create_time,like_count,comment_count,share_count,view_count', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${STATE.creds.tiktok}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ max_count: 20 })
    });
    const json = await res.json();
    const videos = json?.data?.videos || [];
    if (videos.length > 0) {
      STATE.analytics.videos      = videos;
      STATE.analytics.lastFetched = new Date().toISOString();
      STATE.analytics.avgViews    = Math.round(videos.reduce((a, v) => a + (v.view_count||0), 0) / videos.length);
      const avgLikes = videos.reduce((a, v) => a + (v.like_count||0), 0) / videos.length;
      STATE.analytics.engRate     = STATE.analytics.avgViews > 0 ? parseFloat((avgLikes / STATE.analytics.avgViews * 100).toFixed(2)) : 0;
      STATE.analytics.topPerformer = videos.reduce((a, b) => (a.view_count||0) > (b.view_count||0) ? a : b, videos[0]);
      log('analytics', `Stats: avg ${STATE.analytics.avgViews} vues · eng ${STATE.analytics.engRate}%`, 'success');

      // Diffuser le rapport
      msg('analytics', 'all', 'analytics_report', { avgViews: STATE.analytics.avgViews, engRate: STATE.analytics.engRate, topVideo: STATE.analytics.topPerformer?.title }, 'high');

      // Signal rotation si engagement faible
      if (STATE.analytics.engRate < 3 && videos.length >= 3) {
        msg('analytics', 'veille', 'strategy_signal', { signal: 'low_engagement', engRate: STATE.analytics.engRate, action: 'explore_new_niche' }, 'high');
        log('analytics', `Engagement faible (${STATE.analytics.engRate}%) → signal rotation niche`, 'warn');
      }
      // Signal top formats à Agent Contenu
      if (videos.length >= 5) {
        const top = [...videos].sort((a,b) => (b.view_count||0)-(a.view_count||0)).slice(0,3).map(v=>v.title);
        msg('analytics', 'contenu', 'content_signal', { topTitles: top }, 'normal');
      }
    }
    STATE.agents.analytics.cycleCount = (STATE.agents.analytics.cycleCount || 0) + 1;
    setAgent('analytics', 'idle', { lastRun: new Date().toISOString() });
  } catch(e) {
    log('analytics', 'Erreur: ' + e.message, 'error');
    setAgent('analytics', 'error');
    if (e.message.includes('401')) alert('api_limit', 'Token TikTok expiré — reconnexion requise', 'analytics');
  }
}

// ════════════════════════════════════════════════════════════════
//  AGENT VEILLE
// ════════════════════════════════════════════════════════════════
async function runVeille() {
  if (!STATE.creds.anthropic) return;
  setAgent('veille', 'running');
  const signals  = getMsgs('veille', true);
  const doRotate = signals.some(m => m.data?.action === 'explore_new_niche');
  markRead('veille');
  log('veille', `Analyse stratégie${doRotate ? ' [rotation niche]' : ''}`);
  try {
    const prompt = doRotate
      ? `Tu es expert TikTok France. La niche "${STATE.strategy.niche}" a un taux d'engagement de ${STATE.analytics.engRate}%, c'est trop faible. Propose une sous-niche similaire plus performante. Réponds UNIQUEMENT avec ce JSON valide, sans aucun texte avant ou après: {"niche":"nom de la nouvelle niche","ton":"Dramatique","raison":"pourquoi cette niche est meilleure","hashtags":["hashtag1","hashtag2","hashtag3"],"visualStyle":"cinematique"}`
      : `Tu es expert TikTok France. Optimise la stratégie pour la niche "${STATE.strategy.niche}". Réponds UNIQUEMENT avec ce JSON valide, sans aucun texte avant ou après: {"optimisation":"conseil d'amelioration concret","hashtags":["hashtag1","hashtag2","hashtag3"],"ton":"Dramatique","visualStyle":"cinematique"}`;

    const res  = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': STATE.creds.anthropic, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    let raw = (data.content||[]).map(b=>b.text||'').join('').trim();
    if (!raw) throw new Error('Réponse vide de Claude — réessai au prochain cycle');
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s === -1 || e === -1) throw new Error('Pas de JSON dans la réponse: ' + raw.slice(0,100));
    raw = raw.slice(s, e+1);
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch(jsonErr) { throw new Error('JSON invalide: ' + raw.slice(0,100)); }

    if (doRotate && parsed.niche) {
      const old = STATE.strategy.niche;
      Object.assign(STATE.strategy, { niche: parsed.niche, ton: parsed.ton || STATE.strategy.ton, topHashtags: parsed.hashtags || [], visualStyle: parsed.visualStyle || STATE.strategy.visualStyle, lastUpdated: new Date().toISOString() });
      log('veille', `Niche: ${old} → ${parsed.niche}`, 'success');
      msg('veille', 'all', 'strategy_update', { niche: parsed.niche, ton: parsed.ton, hashtags: parsed.hashtags, visualStyle: parsed.visualStyle, reason: parsed.raison, oldNiche: old }, 'high');
    } else {
      Object.assign(STATE.strategy, { topHashtags: parsed.hashtags || STATE.strategy.topHashtags, ton: parsed.ton || STATE.strategy.ton, visualStyle: parsed.visualStyle || STATE.strategy.visualStyle, lastUpdated: new Date().toISOString() });
      log('veille', 'Optimisation: ' + parsed.optimisation, 'success');
      msg('veille', 'contenu', 'strategy_update', { niche: STATE.strategy.niche, ton: STATE.strategy.ton, hashtags: parsed.hashtags, visualStyle: parsed.visualStyle }, 'normal');
    }
    STATE.agents.veille.cycleCount = (STATE.agents.veille.cycleCount||0) + 1;
    setAgent('veille', 'idle', { lastRun: new Date().toISOString() });
  } catch(e) {
    log('veille', 'Erreur: ' + e.message, 'error');
    setAgent('veille', 'error');
  }
}

// ════════════════════════════════════════════════════════════════
//  AGENT CONTENU — génère les scripts
// ════════════════════════════════════════════════════════════════
async function runContenu() {
  if (!STATE.creds.anthropic) return;
  if (STATE.scripts.filter(s => s.status === 'ready' || s.status === 'audio_pending').length >= 3) {
    log('contenu', 'Scripts suffisants en pipeline — cycle ignoré');
    return;
  }
  setAgent('contenu', 'running');
  const signals   = getMsgs('contenu', true);
  const topTitles = signals.find(m => m.type === 'content_signal')?.data?.topTitles || [];
  const stratSig  = signals.find(m => m.type === 'strategy_update');
  markRead('contenu');
  if (stratSig) { STATE.strategy.niche = stratSig.data.niche || STATE.strategy.niche; STATE.strategy.ton = stratSig.data.ton || STATE.strategy.ton; }

  const existing = STATE.scripts.map(s => s.titre).join(', ') || 'aucun';
  const topCtx   = topTitles.length > 0 ? `\nFormats qui performent le mieux: ${topTitles.join(', ')}. S'en inspirer.` : '';
  const prompt   = `Génère 2 scripts TikTok pour niche "${STATE.strategy.niche}", ton "${STATE.strategy.ton}", 60 secondes (150 mots max).${topCtx}\nÉviter ces sujets déjà traités: ${existing}.\nJSON sans backticks: {"scripts":[{"titre":"...","accroche":"texte accroche 3-5s","corps":"texte développement","cta":"call to action 5s","hashtags":["h1","h2","h3","h4","h5"],"note_viralite":85,"conseil_visuel":"description précise des images à générer pour illustrer cette histoire (en anglais pour meilleur résultat)","sujet":"résumé 1 phrase"}]}`;

  log('contenu', `Génération scripts — ${STATE.strategy.niche}`);
  try {
    const res  = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': STATE.creds.anthropic, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 3000, messages: [{ role: 'user', content: prompt }] })
    });
    const data   = await res.json();
    let raw = (data.content||[]).map(b=>b.text||'').join('');
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s !== -1 && e !== -1) raw = raw.slice(s, e+1);
    const parsed = JSON.parse(raw);
    parsed.scripts.forEach(sc => {
      STATE.scripts.push({ ...sc, id: `${Date.now()}_${Math.random().toString(36).slice(2,5)}`, status: 'ready', niche: STATE.strategy.niche, visualStyle: STATE.strategy.visualStyle, createdAt: new Date().toISOString() });
    });
    log('contenu', `${parsed.scripts.length} scripts générés`, 'success');
    msg('contenu', 'voix', 'scripts_ready', { count: parsed.scripts.length, titres: parsed.scripts.map(s=>s.titre) }, 'high');
    STATE.agents.contenu.cycleCount = (STATE.agents.contenu.cycleCount||0) + 1;
    setAgent('contenu', 'idle', { lastRun: new Date().toISOString() });
  } catch(e) {
    log('contenu', 'Erreur: ' + e.message, 'error');
    setAgent('contenu', 'error');
    if (e.message.includes('429')) alert('api_limit', 'Quota Anthropic atteint — Agent Contenu reporté', 'contenu');
  }
}

// ════════════════════════════════════════════════════════════════
//  AGENT VOIX — génère les voix-off (ElevenLabs API)
// ════════════════════════════════════════════════════════════════
async function runVoix() {
  if (!STATE.creds.elevenlabs) {
    alert('payment', 'Clé ElevenLabs manquante — configure-la sur Robot #3 puis envoie-la au serveur', 'voix');
    return;
  }
  const scriptsReady = STATE.scripts.filter(s => s.status === 'ready');
  if (scriptsReady.length === 0) { log('voix', 'Aucun script prêt — en attente'); return; }

  setAgent('voix', 'running');

  for (const script of scriptsReady.slice(0, 2)) {
    log('voix', `Génération voix-off: "${script.titre}"`);
    script.status = 'audio_pending';

    const texteComplet = [script.accroche, script.corps, script.cta].filter(Boolean).join(' ');
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${STATE.creds.voiceId}`, {
        method: 'POST',
        headers: { 'xi-api-key': STATE.creds.elevenlabs, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
        body: JSON.stringify({
          text: texteComplet,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true }
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 401 || res.status === 403) {
          alert('payment', 'Clé ElevenLabs invalide ou quota insuffisant — vérifie ton abonnement', 'voix');
          script.status = 'ready'; // Remettre en attente
          break;
        }
        throw new Error(`ElevenLabs HTTP ${res.status}: ${JSON.stringify(err)}`);
      }

      const audioBuffer = await res.buffer();
      const slug        = script.titre.replace(/[^a-z0-9]/gi, '_').slice(0, 28).toLowerCase();
      const filename    = `voixoff_${Date.now()}_${slug}.mp3`;
      const audioPath   = path.join('/tmp/audio', filename);
      fs.writeFileSync(audioPath, audioBuffer);

      const audioEntry = { scriptId: script.id, filename, path: audioPath, size: audioBuffer.length };
      STATE.audioFiles.push(audioEntry);
      script.status   = 'audio_ready';
      script.audioFile = filename;

      log('voix', `✅ Voix-off générée: ${filename} (${formatBytes(audioBuffer.length)})`, 'success');
      msg('voix', 'montage', 'audio_ready', { scriptId: script.id, titre: script.titre, audioFile: filename }, 'high');

      await sleep(1000); // Pause entre les appels ElevenLabs

    } catch(e) {
      script.status = 'ready'; // Remettre en attente pour retry
      log('voix', `Erreur voix "${script.titre}": ${e.message}`, 'error');
      if (e.message.includes('quota') || e.message.includes('429')) {
        alert('payment', 'Quota ElevenLabs dépassé — vérifie ton abonnement', 'voix');
        break;
      }
    }
  }

  STATE.agents.voix.cycleCount = (STATE.agents.voix.cycleCount||0) + 1;
  setAgent('voix', 'idle', { lastRun: new Date().toISOString() });
}

// ════════════════════════════════════════════════════════════════
//  AGENT MONTAGE — génère images IA + assemble vidéo (FFmpeg)
// ════════════════════════════════════════════════════════════════

// Télécharger une image depuis Pollinations.ai
async function downloadImage(prompt, outputPath, style) {
  const styleMap = {
    cinematique: 'cinematic vertical 9:16, dramatic lighting, moody atmospheric, high quality photorealistic',
    mystere:     'dark mysterious noir cinematic vertical 9:16, eerie fog, dramatic shadows, high quality',
    dynamique:   'dynamic energetic vibrant vertical 9:16, high contrast, modern, high quality',
  };
  const styleTag = styleMap[style] || styleMap.cinematique;
  const fullPrompt = `${prompt}, ${styleTag}`.slice(0, 250);
  const encoded    = encodeURIComponent(fullPrompt);
  const seed       = Math.floor(Math.random() * 99999);
  const url        = `https://image.pollinations.ai/prompt/${encoded}?width=1080&height=1920&seed=${seed}&nologo=true&enhance=true`;

  // Essayer 2 fois avec des seeds différents
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const seedRetry = Math.floor(Math.random() * 99999);
      const urlRetry  = attempt === 0 ? url : url.replace(/seed=\d+/, `seed=${seedRetry}`);
      res = await fetch(urlRetry, { timeout: 25000 });
      if (res.ok) break;
    } catch(fetchErr) {
      if (attempt === 1) throw fetchErr;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (!res || !res.ok) throw new Error(`Pollinations HTTP ${res?.status || 'timeout'}`);
  const buf = await res.buffer();
  fs.writeFileSync(outputPath, buf);
  return outputPath;
}

// Découper le texte en segments de 5 secondes
function preparerSegments(script, audioDurationSec) {
  const texte    = [script.accroche, script.corps, script.cta].filter(Boolean).join(' ');
  const mots     = texte.split(/\s+/).filter(Boolean);
  const nbSeg    = Math.max(1, Math.ceil(audioDurationSec / 5));
  const mParSeg  = Math.ceil(mots.length / nbSeg);
  const segments = [];
  for (let i = 0; i < nbSeg; i++) {
    const segMots  = mots.slice(i * mParSeg, (i+1) * mParSeg);
    const texteVis = script.conseil_visuel || script.sujet || script.titre;
    // Prompt visuel : conseil_visuel pour seg 0, puis mots du segment
    const prompt   = i === 0 ? texteVis : (segMots.slice(0,4).join(' ') + ' ' + (texteVis||'')).trim();
    segments.push({ texte: segMots.join(' '), prompt, duration: 5 });
  }
  // Ajuster la durée du dernier segment
  if (segments.length > 0) {
    const totalFixed = (segments.length - 1) * 5;
    segments[segments.length - 1].duration = Math.max(3, audioDurationSec - totalFixed);
  }
  return segments;
}

// Obtenir la durée d'un fichier audio
// Priorité : ffprobe → estimation par taille (128kbps) → 60s par défaut
function getAudioDuration(audioPath) {
  return new Promise((resolve) => {
    if (!ffmpeg) {
      // Estimation par taille (ElevenLabs ≈ 128kbps)
      try {
        const size = fs.statSync(audioPath).size;
        resolve(Math.max(15, Math.min(120, (size * 8) / (128 * 1000))));
      } catch(e) { resolve(60); }
      return;
    }
    ffmpeg.ffprobe(audioPath, (err, meta) => {
      if (!err && meta?.format?.duration) {
        resolve(meta.format.duration);
      } else {
        // Fallback : estimation par taille de fichier (ElevenLabs = ~128kbps)
        try {
          const sizeBytes = require('fs').statSync(audioPath).size;
          const estimated = (sizeBytes * 8) / (128 * 1000);  // secondes
          const duration  = Math.max(15, Math.min(120, estimated));
          console.log(`[Montage] Durée estimée: ${Math.round(duration)}s (taille: ${Math.round(sizeBytes/1024)}Ko)`);
          resolve(duration);
        } catch(e2) {
          resolve(60); // Fallback absolu
        }
      }
    });
  });
}

// Échapper le texte pour FFmpeg drawtext (supprimer tous les caractères spéciaux)
function sanitizeDrawtext(texte) {
  return (texte || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // Supprimer les accents
    .replace(/[^a-zA-Z0-9 .,!?]/g, ' ')                  // Garder uniquement alphanum + ponctuation simple
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

// Couper un texte en lignes de N caractères max
function couperLignes(texte, maxChars = 28) {
  const mots = texte.split(' ').filter(Boolean);
  const lignes = [];
  let ligne = '';
  mots.forEach(m => {
    if ((ligne + (ligne?' ':'') + m).length > maxChars) {
      if (ligne) lignes.push(ligne);
      ligne = m.slice(0, maxChars);
    } else {
      ligne = (ligne ? ligne + ' ' : '') + m;
    }
  });
  if (ligne) lignes.push(ligne);
  return lignes.slice(0, 3).join('\n'); // Max 3 lignes
}

// Créer un segment vidéo (image + durée + sous-titre)
function creerSegmentVideo(imagePath, duration, texte, outputPath, couleur = 'white') {
  return new Promise((resolve, reject) => {
    const textSafe = sanitizeDrawtext(texte);
    const textML   = couperLignes(textSafe);
    const fontColor = couleur === 'yellow' ? 'yellow' : 'white';

    // Si pas de texte, créer le segment sans drawtext
    const filters = [
      'scale=1080:1920:force_original_aspect_ratio=increase',
      'crop=1080:1920',
    ];
    if (textML.trim()) {
      filters.push(
        `drawtext=text='${textML}':fontsize=54:fontcolor=${fontColor}:borderw=4:bordercolor=black@0.8:x=(w-text_w)/2:y=h-320:line_spacing=12:font=DejaVu-Sans-Bold`
      );
    }

    if (!ffmpeg) { resolve(); return; } // FFmpeg non dispo — segment vide
    ffmpeg(imagePath)
      .inputOptions(['-loop 1', `-t ${duration}`])
      .videoFilters(filters)
      .outputOptions(['-c:v libx264', '-preset ultrafast', '-pix_fmt yuv420p', `-t ${duration}`, '-r 30'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', (err) => {
        console.warn('[Montage] drawtext échoué, retry sans texte:', err.message.slice(0,80));
        ffmpeg(imagePath)
          .inputOptions(['-loop 1', `-t ${duration}`])
          .videoFilters(['scale=1080:1920:force_original_aspect_ratio=increase','crop=1080:1920'])
          .outputOptions(['-c:v libx264', '-preset ultrafast', '-pix_fmt yuv420p', `-t ${duration}`, '-r 30'])
          .output(outputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      })
      .run();
  });
}

// Assembler tous les segments en une vidéo finale avec audio
function assemblerVideo(segmentPaths, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpeg) { reject(new Error('FFmpeg non disponible sur ce serveur')); return; }
    const listFile = outputPath.replace('.mp4', '_list.txt');
    const listContent = segmentPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(listFile, listContent);

    ffmpeg()
      .input(listFile).inputOptions(['-f concat', '-safe 0'])
      .input(audioPath)
      .outputOptions(['-c:v copy', '-c:a aac', '-shortest', '-movflags +faststart'])
      .output(outputPath)
      .on('end', () => { try { fs.unlinkSync(listFile); } catch(e) {} resolve(); })
      .on('error', reject)
      .run();
  });
}

async function runMontage() {
  const scriptsReady = STATE.scripts.filter(s => s.status === 'audio_ready' && s.audioFile);
  if (scriptsReady.length === 0) { log('montage', 'Aucun audio prêt — en attente Agent Voix'); return; }

  setAgent('montage', 'running');

  for (const script of scriptsReady.slice(0, 1)) { // 1 vidéo par cycle (CPU intensif)
    log('montage', `Montage: "${script.titre}"`);
    script.status = 'video_pending';

    const audioPath = path.join('/tmp/audio', script.audioFile);
    if (!fs.existsSync(audioPath)) {
      log('montage', `Audio introuvable: ${script.audioFile}`, 'error');
      script.status = 'audio_ready'; continue;
    }

    try {
      // 1. Durée de l'audio
      log('montage', 'Lecture durée audio...');
      const duration = await getAudioDuration(audioPath);
      log('montage', `Durée audio: ${Math.round(duration)}s`);

      // 2. Préparer les segments
      const segments = preparerSegments(script, duration);
      const style    = script.visualStyle || STATE.strategy.visualStyle || 'cinematique';
      const couleur  = style === 'dynamique' ? 'yellow' : 'white';

      // 3. Générer les images IA (en parallèle par batch de 3)
      log('montage', `Génération ${segments.length} images IA (Pollinations.ai)...`);
      const imagePaths = new Array(segments.length).fill(null);
      const BATCH = 3;
      for (let b = 0; b < segments.length; b += BATCH) {
        const end = Math.min(b + BATCH, segments.length);
        await Promise.all(
          segments.slice(b, end).map(async (seg, j) => {
            const imgPath = path.join('/tmp/images', `${script.id}_seg${b+j}.jpg`);
            try {
              await downloadImage(seg.prompt, imgPath, style);
              imagePaths[b+j] = imgPath;
              log('montage', `Image ${b+j+1}/${segments.length} générée`);
            } catch(e) {
              // Créer une image de fallback noire
              log('montage', `Image ${b+j+1} échouée (fallback noir)`, 'warn');
              await creerImageFallback(imgPath, style);
              imagePaths[b+j] = imgPath;
            }
          })
        );
        await sleep(500); // Pause entre batchs
      }

      // 4. Créer les segments vidéo
      log('montage', `Composition ${segments.length} segments vidéo...`);
      const segVideoPaths = [];
      for (let i = 0; i < segments.length; i++) {
        const segPath = path.join('/tmp/segments', `${script.id}_seg${i}.mp4`);
        await creerSegmentVideo(imagePaths[i], segments[i].duration, segments[i].texte, segPath, couleur);
        segVideoPaths.push(segPath);
        log('montage', `Segment ${i+1}/${segments.length} encodé`);
      }

      // 5. Assembler la vidéo finale avec audio
      log('montage', 'Assemblage final avec audio...');
      const slug     = script.titre.replace(/[^a-z0-9]/gi, '_').slice(0, 28).toLowerCase();
      const outFile  = `tiktok_${Date.now()}_${slug}.mp4`;
      const outPath  = path.join('/tmp/videos', outFile);
      await assemblerVideo(segVideoPaths, audioPath, outPath);

      const stat = fs.statSync(outPath);
      log('montage', `✅ Vidéo créée: ${outFile} (${formatBytes(stat.size)})`, 'success');

      // Nettoyer les fichiers temporaires
      [...imagePaths, ...segVideoPaths].forEach(p => { try { if(p) fs.unlinkSync(p); } catch(e) {} });

      // Enregistrer la vidéo
      STATE.videoFiles.push({ scriptId: script.id, filename: outFile, path: outPath, size: stat.size, createdAt: new Date().toISOString() });
      script.status    = 'video_ready';
      script.videoFile = outFile;

      // Planifier la publication
      const scheduledAt = prochainCreneau();
      STATE.publishQueue[outFile] = {
        titre: script.titre, caption: [script.accroche, script.corps, script.cta].filter(Boolean).join(' ').slice(0, 300),
        hashtags: script.hashtags || [], filePath: outPath, fileSize: stat.size,
        scheduledAt, status: 'pending_approval',  // Attente validation humaine (ou auto après 2h)
        addedAt: new Date().toISOString(), error: null,
        autoApproveAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString(), // Auto-approuvé dans 2h
      };

      // Timer auto-approbation dans 2h si pas de réponse humaine
      setTimeout(() => {
        const v = STATE.publishQueue[outFile];
        if (v && v.status === 'pending_approval') {
          v.status = 'scheduled';
          log('montage', `Auto-approuvé: "${v.titre}" (aucune intervention en 2h)`, 'info');
          msg('montage', 'pub', 'video_approved', { titre: v.titre, auto: true }, 'normal');
        }
      }, 2 * 3600 * 1000);

      msg('montage', 'pub', 'video_ready', { titre: script.titre, videoFile: outFile, scheduledAt }, 'high');
      msg('montage', 'all', 'video_created', { titre: script.titre, size: formatBytes(stat.size), scheduledAt }, 'normal');
      log('montage', `Planifié pour publication: ${scheduledAt?.toLocaleString('fr-FR')}`, 'success');

    } catch(e) {
      script.status = 'audio_ready'; // retry
      log('montage', `Erreur montage "${script.titre}": ${e.message}`, 'error');
    }
  }

  STATE.agents.montage.cycleCount = (STATE.agents.montage.cycleCount||0) + 1;
  setAgent('montage', 'idle', { lastRun: new Date().toISOString() });
}

// Image de fallback — dégradé coloré selon le style
async function creerImageFallback(outputPath, style) {
  return new Promise((resolve) => {
    const gradients = {
      mystere:    'color=c=0x0a0510:size=1080x1920,geq=r='10+5*sin(X/100)':g='5+3*sin(Y/150)':b='25+15*sin((X+Y)/200)'',
      dynamique:  'color=c=0x100a05:size=1080x1920,geq=r='20+10*sin(X/80)':g='10+5*sin(Y/100)':b='5'',
      cinematique:'color=c=0x050a15:size=1080x1920,geq=r='5':g='10+5*sin(X/120)':b='25+15*sin(Y/180)'',
    };
    const filter = gradients[style] || gradients.cinematique;
    if (!ffmpeg) {
      // Créer directement un JPEG noir si FFmpeg absent
      const jpegBlack = Buffer.from('FFD8FFE000104A464946000101000001000100 00FFD9'.replace(/\s/g,''), 'hex');
      try { fs.writeFileSync(outputPath, jpegBlack); } catch(e) { fs.writeFileSync(outputPath, Buffer.alloc(100)); }
      resolve(); return;
    }
    ffmpeg()
      .input(filter.split(',')[0])
      .inputOptions(['-f lavfi'])
      .outputOptions(['-t 1', '-frames:v 1', '-vf', filter.split(',')[1] || 'null'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', () => {
        // Fallback ultime : créer une image JPEG noire via Buffer
        try {
          // Petit JPEG noir 1x1 pixel répété
          const jpegBlack = Buffer.from([
            0xFF,0xD8,0xFF,0xE0,0x00,0x10,0x4A,0x46,0x49,0x46,0x00,0x01,0x01,0x00,0x00,0x01,
            0x00,0x01,0x00,0x00,0xFF,0xDB,0x00,0x43,0x00,0x08,0x06,0x06,0x07,0x06,0x05,0x08,
            0x07,0x07,0x07,0x09,0x09,0x08,0x0A,0x0C,0x14,0x0D,0x0C,0x0B,0x0B,0x0C,0x19,0x12,
            0x13,0x0F,0x14,0x1D,0x1A,0x1F,0x1E,0x1D,0x1A,0x1C,0x1C,0x20,0x24,0x2E,0x27,0x20,
            0x22,0x2C,0x23,0x1C,0x1C,0x28,0x37,0x29,0x2C,0x30,0x31,0x34,0x34,0x34,0x1F,0x27,
            0x39,0x3D,0x38,0x32,0x3C,0x2E,0x33,0x34,0x32,0xFF,0xC0,0x00,0x0B,0x08,0x00,0x01,
            0x00,0x01,0x01,0x01,0x11,0x00,0xFF,0xC4,0x00,0x1F,0x00,0x00,0x01,0x05,0x01,0x01,
            0x01,0x01,0x01,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x02,0x03,0x04,
            0x05,0x06,0x07,0x08,0x09,0x0A,0x0B,0xFF,0xDA,0x00,0x08,0x01,0x01,0x00,0x00,0x3F,
            0x00,0xF5,0x0A,0xFF,0xD9
          ]);
          fs.writeFileSync(outputPath, jpegBlack);
        } catch(e2) {
          fs.writeFileSync(outputPath, Buffer.alloc(1000, 0));
        }
        resolve();
      })
      .run();
  });
}

// Calculer le prochain créneau de publication
function prochainCreneau() {
  const now   = new Date();
  const hours = STATE.strategy.bestHours || [8, 19, 21];
  // Trouver le prochain créneau futur
  for (let dayOffset = 0; dayOffset <= 3; dayOffset++) {
    for (const h of hours) {
      const candidate = new Date(now);
      candidate.setDate(candidate.getDate() + dayOffset);
      candidate.setHours(h, 0, 0, 0);
      if (candidate > now) {
        // Vérifier qu'aucune autre vidéo n'est déjà planifiée à cette heure
        const busy = Object.values(STATE.publishQueue).some(v => {
          if (!v.scheduledAt || v.status === 'published') return false;
          const diff = Math.abs(new Date(v.scheduledAt) - candidate) / 60000;
          return diff < 60;
        });
        if (!busy) return candidate;
      }
    }
  }
  // Fallback : +2h depuis maintenant
  return new Date(Date.now() + 2 * 3600000);
}

// ════════════════════════════════════════════════════════════════
//  AGENT PUBLICATION
// ════════════════════════════════════════════════════════════════
function runPub() {
  const signals = getMsgs('pub', true); markRead('pub');
  const schedSig = signals.find(m => m.type === 'schedule_update');
  if (schedSig?.data?.bestHours) {
    STATE.strategy.bestHours = schedSig.data.bestHours;
    log('pub', `Horaires optimaux mis à jour: ${STATE.strategy.bestHours.join('h, ')}h`, 'success');
  }
  const pending = Object.values(STATE.publishQueue).filter(v => v.status === 'scheduled').length;
  log('pub', `${pending} vidéo(s) planifiée(s) en attente`);
  Object.entries(STATE.publishQueue).forEach(([fn, v]) => {
    if (v.status === 'scheduled' && v.scheduledAt && new Date(v.scheduledAt) <= new Date()) {
      log('pub', `Heure atteinte → publication "${v.titre}"`);
      publierVideo(fn);
    }
  });
  STATE.agents.pub.cycleCount = (STATE.agents.pub.cycleCount||0) + 1;
  setAgent('pub', 'idle', { lastRun: new Date().toISOString() });
}

async function publierVideo(filename) {
  const v = STATE.publishQueue[filename];
  if (!v || !STATE.creds.tiktok) return;
  v.status = 'uploading';
  setAgent('pub', 'running');
  log('pub', `Upload TikTok: "${v.titre}"`);
  try {
    if (!fs.existsSync(v.filePath)) throw new Error('Fichier vidéo introuvable: ' + v.filePath);
    const buf  = fs.readFileSync(v.filePath);
    const size = buf.length;
    const cap  = (v.caption || v.titre || '').slice(0, 150) + '\n\n' + (v.hashtags||[]).map(h=>'#'+h.replace('#','')).join(' ');

    const init = await fetch('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${STATE.creds.tiktok}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ post_info: { title: cap.slice(0,150), privacy_level: 'SELF_ONLY', disable_duet:false, disable_comment:false, disable_stitch:false }, source_info: { source:'FILE_UPLOAD', video_size:size, chunk_size:size, total_chunk_count:1 } })
    });
    const id = await init.json();
    if (!id?.data?.publish_id) throw new Error('Init TikTok échoué: ' + JSON.stringify(id?.error));
    v.tiktokPublishId = id.data.publish_id;

    await fetch(id.data.upload_url, { method:'PUT', headers:{ 'Content-Type':'video/mp4', 'Content-Range':`bytes 0-${size-1}/${size}`, 'Content-Length':String(size) }, body: buf });

    for (let i=0; i<12; i++) {
      await sleep(5000);
      const st = await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', { method:'POST', headers:{'Authorization':`Bearer ${STATE.creds.tiktok}`,'Content-Type':'application/json; charset=UTF-8'}, body: JSON.stringify({ publish_id: id.data.publish_id }) });
      const sd = await st.json();
      const status = sd?.data?.status;
      if (status === 'PUBLISH_COMPLETE' || status === 'SEND_TO_USER_INBOX') {
        v.status = 'published'; v.publishedAt = new Date().toISOString();
        log('pub', `✅ Publié sur TikTok: "${v.titre}"`, 'success');
        msg('pub', 'analytics', 'video_published', { titre: v.titre, publishId: id.data.publish_id }, 'high');
        try { fs.unlinkSync(v.filePath); } catch(e) {}
        break;
      }
      if (status === 'FAILED') throw new Error('TikTok a refusé la vidéo: ' + JSON.stringify(sd?.data));
    }
  } catch(e) {
    v.status = 'error'; v.error = e.message;
    log('pub', 'Erreur publication: ' + e.message, 'error');
    if (e.message.includes('401')) alert('api_limit', 'Token TikTok expiré — reconnexion requise sur Robot #5', 'pub');
  }
  setAgent('pub', 'idle', { lastRun: new Date().toISOString() });
}

// ════════════════════════════════════════════════════════════════
//  ORCHESTRATEUR — cycle toutes les heures
// ════════════════════════════════════════════════════════════════
async function runOrchestrator() {
  log('orchestrateur', '═══ CYCLE ORCHESTRATEUR ═══');
  await runAnalytics();  await sleep(2000);
  await runVeille();     await sleep(2000);
  await runContenu();    await sleep(2000);
  await runVoix();       await sleep(2000);
  await runMontage();    await sleep(1000);
  runPub();
  log('orchestrateur', '═══ CYCLE TERMINÉ ═══', 'success');
}

// Cycle toutes les heures
cron.schedule('0 * * * *', runOrchestrator);
// Vérification publications toutes les 5 minutes
cron.schedule('*/5 * * * *', () => {
  Object.entries(STATE.publishQueue).forEach(([fn, v]) => {
    if (v.status === 'scheduled' && v.scheduledAt && new Date(v.scheduledAt) <= new Date()) publierVideo(fn);
  });
});

// ════════════════════════════════════════════════════════════════
//  ROUTES API
// ════════════════════════════════════════════════════════════════
app.get('/', (req,res) => res.json({ status:'ok', message:'TikTok Agent Suite v3 — 5 agents autonomes', version:'3.0.0' }));

app.get('/dashboard', (req,res) => res.json({
  agents: STATE.agents, strategy: STATE.strategy,
  analytics: { ...STATE.analytics, videos: STATE.analytics.videos.slice(0,5) },
  alerts: STATE.alerts.filter(a => !a.resolved),
  scripts: STATE.scripts.slice(0,15).map(s=>({ id:s.id,titre:s.titre,status:s.status,niche:s.niche,createdAt:s.createdAt })),
  audioFiles: STATE.audioFiles.slice(0,10).map(a=>({ scriptId:a.scriptId,filename:a.filename,size:a.size })),
  videoFiles: STATE.videoFiles.slice(0,10).map(v=>({ scriptId:v.scriptId,filename:v.filename,size:v.size,createdAt:v.createdAt })),
  publishQueue: Object.fromEntries(Object.entries(STATE.publishQueue).map(([k,v])=>[k,{ titre:v.titre,status:v.status,scheduledAt:v.scheduledAt,publishedAt:v.publishedAt,error:v.error }])),
  messageBus: STATE.messageBus.slice(0,30),
  actionLog: STATE.actionLog.slice(0,50),
  credentials: { tiktok:!!STATE.creds.tiktok, anthropic:!!STATE.creds.anthropic, elevenlabs:!!STATE.creds.elevenlabs },
}));

app.post('/configure', (req,res) => {
  const { token, anthropic_key, elevenlabs_key, voice_id, niche, ton, pexels_key } = req.body;
  if (token)          { STATE.creds.tiktok      = token;          log('system','Token TikTok configuré','success'); }
  if (anthropic_key)  { STATE.creds.anthropic   = anthropic_key;  log('system','Clé Anthropic configurée','success'); }
  if (elevenlabs_key) { STATE.creds.elevenlabs  = elevenlabs_key; log('system','Clé ElevenLabs configurée','success'); }
  if (voice_id)         STATE.creds.voiceId    = voice_id;
  if (niche)          { STATE.strategy.niche   = niche; }
  if (ton)              STATE.strategy.ton     = ton;
  res.json({ ok:true, credentials:{ tiktok:!!STATE.creds.tiktok, anthropic:!!STATE.creds.anthropic, elevenlabs:!!STATE.creds.elevenlabs } });
});

// Upload manuel (depuis Robot #5)
app.post('/schedule', upload.single('video'), (req,res) => {
  if (!req.file) return res.status(400).json({ error:'Fichier requis' });
  const { titre, caption, hashtags, scheduled_at } = req.body;
  const fn = req.file.originalname || req.file.filename;
  const sa = scheduled_at ? new Date(scheduled_at) : prochainCreneau();
  STATE.publishQueue[fn] = { titre, caption, filePath:req.file.path, fileSize:req.file.size, hashtags:hashtags?JSON.parse(hashtags):[], scheduledAt:sa, status:'scheduled', addedAt:new Date().toISOString(), error:null };
  if (sa && sa > new Date()) { const d=sa.getTime()-Date.now(); setTimeout(()=>publierVideo(fn),d); }
  else setImmediate(()=>publierVideo(fn));
  res.json({ ok:true, filename:fn, scheduledAt:sa });
});

app.get('/status',   (req,res) => res.json({ ok:true, queue:STATE.publishQueue, token_set:!!STATE.creds.tiktok }));
app.get('/messages', (req,res) => res.json({ messages:STATE.messageBus.slice(0,50) }));
app.get('/logs',     (req,res) => res.json({ logs:STATE.actionLog.slice(0,100) }));
app.get('/alerts',   (req,res) => res.json({ alerts:STATE.alerts }));
app.post('/alerts/:id/resolve', (req,res) => { const a=STATE.alerts.find(a=>a.id===parseInt(req.params.id)); if(a) a.resolved=true; res.json({ok:true}); });
app.get('/scripts',  (req,res) => res.json({ scripts:STATE.scripts }));
app.get('/strategy', (req,res) => res.json({ strategy:STATE.strategy }));
app.post('/strategy',(req,res) => { Object.assign(STATE.strategy,req.body); STATE.strategy.lastUpdated=new Date().toISOString(); log('system','Stratégie mise à jour manuellement'); res.json({ok:true,strategy:STATE.strategy}); });

app.post('/run/:agent', async (req,res) => {
  const { agent } = req.params;
  res.json({ ok:true, message:`Agent ${agent} démarré` });
  if (agent==='analytics') await runAnalytics();
  else if (agent==='veille')  await runVeille();
  else if (agent==='contenu') await runContenu();
  else if (agent==='voix')    await runVoix();
  else if (agent==='montage') await runMontage();
  else if (agent==='pub')     runPub();
  else if (agent==='all')     await runOrchestrator();
});

// ── Progression temps réel des agents ────────────────────────────
app.get('/progress', (req, res) => {
  const steps = [
    { agent: 'analytics', label: 'Analyse TikTok',      done: (STATE.agents.analytics?.cycleCount||0) > 0 },
    { agent: 'veille',    label: 'Stratégie niche',      done: (STATE.agents.veille?.cycleCount||0) > 0 },
    { agent: 'contenu',   label: 'Génération scripts',   done: STATE.scripts.length > 0 },
    { agent: 'voix',      label: 'Voix-off ElevenLabs',  done: STATE.audioFiles.length > 0 },
    { agent: 'montage',   label: 'Montage vidéo IA',     done: STATE.videoFiles.length > 0 },
    { agent: 'pub',       label: 'Publication TikTok',   done: Object.values(STATE.publishQueue).some(v=>v.status==='published') },
  ];
  const currentAgent = Object.entries(STATE.agents).find(([,a]) => a.status === 'running')?.[0] || null;
  const currentStep  = steps.findIndex(s => s.agent === currentAgent);
  const doneCount    = steps.filter(s=>s.done).length;
  res.json({ steps, currentAgent, currentStep, doneCount, total: steps.length, pct: Math.round(doneCount/steps.length*100) });
});

// ── Approbation / Rejet vidéo par l'utilisateur ────────────────
app.post('/video/:filename/approve', (req, res) => {
  const v = STATE.publishQueue[req.params.filename];
  if (!v) return res.status(404).json({ error: 'Vidéo introuvable' });
  v.status = 'scheduled';
  v.approvedAt = new Date().toISOString();
  log('system', `✅ Vidéo approuvée manuellement: "${v.titre}"`, 'success');
  msg('system', 'pub', 'video_approved', { titre: v.titre, manual: true }, 'high');
  res.json({ ok: true, scheduledAt: v.scheduledAt });
});

app.post('/video/:filename/reject', async (req, res) => {
  const v = STATE.publishQueue[req.params.filename];
  if (!v) return res.status(404).json({ error: 'Vidéo introuvable' });
  const titreRejete = v.titre;
  // Supprimer la vidéo
  try { if (fs.existsSync(v.filePath)) fs.unlinkSync(v.filePath); } catch(e) {}
  delete STATE.publishQueue[req.params.filename];
  STATE.videoFiles = STATE.videoFiles.filter(vf => vf.filename !== req.params.filename);
  // Marquer le script comme rejeté pour régénération
  const sc = STATE.scripts.find(s => s.titre === titreRejete);
  if (sc) { sc.status = 'rejected'; sc.rejectedAt = new Date().toISOString(); }
  log('system', `❌ Vidéo rejetée: "${titreRejete}" — régénération au prochain cycle`, 'warn');
  msg('system', 'contenu', 'content_rejected', { titre: titreRejete, reason: req.body?.reason || 'Rejet manuel' }, 'high');
  res.json({ ok: true });
  // Déclencher immédiatement un nouveau cycle contenu
  setTimeout(async () => {
    if (sc) { sc.status = 'needs_regen'; }
    STATE.scripts = STATE.scripts.filter(s => s.status !== 'rejected');
    await runContenu();
  }, 3000);
});

// ── Route streaming vidéo — pour preview depuis le dashboard ────
app.get('/video/:filename', (req, res) => {
  const filename = req.params.filename.replace(/\.\./g, ''); // sécurité
  const filePath = path.join('/tmp/videos', filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Vidéo introuvable' });

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    // Support du streaming range (nécessaire pour HTML5 video)
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end   = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunk = end - start + 1;
    const stream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': chunk,
      'Content-Type':   'video/mp4',
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ── Liste des vidéos disponibles pour preview ──────────────────
app.get('/videos/list', (req, res) => {
  try {
    const dir = '/tmp/videos';
    if (!fs.existsSync(dir)) return res.json({ videos: [] });
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.mp4') || f.endsWith('.webm'))
      .map(f => {
        const fp  = path.join(dir, f);
        const st  = fs.statSync(fp);
        // Trouver le script associé
        const sc  = STATE.scripts.find(s => s.videoFile === f);
        const pq  = STATE.publishQueue[f];
        return {
          filename:    f,
          size:        st.size,
          createdAt:   st.birthtime,
          titre:       sc?.titre || pq?.titre || f,
          status:      pq?.status || 'ready',
          scheduledAt: pq?.scheduledAt || null,
          url:         `/video/${f}`,
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ videos: files });
  } catch(e) {
    res.json({ videos: [] });
  }
});

app.listen(PORT, () => {
  console.log(`\n🤖 TikTok Agent Suite v3 — port ${PORT}`);
  console.log('   5 agents autonomes: Veille, Contenu, Voix, Montage, Publication');
  console.log('   Cycle orchestrateur: toutes les heures\n');
  log('system', 'Serveur démarré', 'success');
  // Premier cycle après 1 minute (laisser le temps à Railway de démarrer)
  setTimeout(runOrchestrator, 60000);
});
