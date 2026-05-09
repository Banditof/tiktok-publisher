// ════════════════════════════════════════════════════════════════
//  TIKTOK AGENT SUITE v4 — 6 AGENTS IA AUTONOMES
//  Chaque agent apprend et s'améliore au fil des publications
// ════════════════════════════════════════════════════════════════
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Chargement optionnel des modules
let fetch  = null; try { fetch  = require('node-fetch');  } catch(e) { console.warn('[WARN] node-fetch'); }
let cron   = null; try { cron   = require('node-cron');   } catch(e) { console.warn('[WARN] node-cron'); }
let multer = null; try { multer = require('multer');      } catch(e) { console.warn('[WARN] multer'); }
let ffmpeg = null;
try {
  ffmpeg = require('fluent-ffmpeg');
  const fp = require('@ffmpeg-installer/ffmpeg').path;
  ffmpeg.setFfmpegPath(fp);
  try { const pp = fp.replace(/ffmpeg([^/\\]*)$/, 'ffprobe$1'); if (fs.existsSync(pp)) ffmpeg.setFfprobePath(pp); } catch(e) {}
  console.log('[OK] FFmpeg disponible');
} catch(e) { ffmpeg = null; console.warn('[WARN] FFmpeg non disponible — montage limité'); }

['/tmp/audio','/tmp/images','/tmp/videos','/tmp/segments','/tmp/uploads'].forEach(d => {
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch(e) {}
});

// ════════════════════════════════════════════════════════════════
//  ÉTAT GLOBAL — mémoire des agents (apprentissage)
// ════════════════════════════════════════════════════════════════
const STATE = {
  creds: { tiktok: '', anthropic: '', elevenlabs: '', voiceId: '' },

  // Stratégie apprise au fil du temps
  apprentissage: {
    sujetsPublies:    [],   // Historique pour éviter doublons
    performanceSujets: {},  // sujet → { vues, likes, partages, note }
    voixPerformantes: {},   // voiceId → note moyenne
    heuresOptimales:  [8, 19, 21],
    stylesGagnants:   [],   // styles visuels qui performent
    nichesTestees:    {},   // niche → engagement moyen
    totalPublications: 0,
  },

  // Pipeline de contenu
  sujets:       [],  // Proposés par Agent Veille
  scripts:      [],  // Créés par Agent Script
  audioFiles:   [],  // Créés par Agent Voix-off
  videoFiles:   [],  // Créés par Agent Montage
  publishQueue: {},  // Gérés par Agent Publication

  // Analytics TikTok
  analytics: { videos: [], avgViews: 0, avgShares: 0, engRate: 0, lastFetched: null },

  // Agents
  agents: {
    veille:    { status: 'idle', lastRun: null, cycleCount: 0, lastAction: '', decision: '' },
    script:    { status: 'idle', lastRun: null, cycleCount: 0, lastAction: '', decision: '' },
    voix:      { status: 'idle', lastRun: null, cycleCount: 0, lastAction: '', decision: '' },
    montage:   { status: 'idle', lastRun: null, cycleCount: 0, lastAction: '', decision: '' },
    pub:       { status: 'idle', lastRun: null, cycleCount: 0, lastAction: '', decision: '' },
    analytics: { status: 'idle', lastRun: null, cycleCount: 0, lastAction: '', decision: '' },
  },

  messageBus: [], alerts: [], actionLog: [],
};

// Voix ElevenLabs disponibles avec profils
const VOIX = {
  'pNInz6obpgDQGcFmaJgB': { nom: 'Adam',    genre: 'homme',  style: 'autoritaire,dramatique,mystere' },
  'EXAVITQu4vr4xnSDxMaL': { nom: 'Bella',   genre: 'femme',  style: 'emotionnel,dramatique,histoire' },
  'TxGEqnHWrfWFTfGW9XjX': { nom: 'Josh',    genre: 'homme',  style: 'grave,thriller,suspense' },
  'MF3mGyEYCl7XYWbV9V6O': { nom: 'Elli',    genre: 'femme',  style: 'doux,emotionnel,touchant' },
  'ErXwobaYiN019PkySvjV': { nom: 'Antoni',  genre: 'homme',  style: 'chaleureux,positif,storytelling' },
  '21m00Tg0V1IjIsMNGjAf': { nom: 'Rachel',  genre: 'femme',  style: 'calme,informatif,mysterieux' },
};

// ════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════
function msg(from, to, type, data, priority = 'normal') {
  const m = { id: `${Date.now()}_${Math.random().toString(36).slice(2,6)}`, from, to, type, data, priority, timestamp: new Date().toISOString(), read: false };
  STATE.messageBus.unshift(m);
  if (STATE.messageBus.length > 200) STATE.messageBus = STATE.messageBus.slice(0, 200);
  return m;
}
function getMsgs(agent, unread = false) {
  return STATE.messageBus.filter(m => (m.to === agent || m.to === 'all') && (!unread || !m.read));
}
function markRead(agent) { STATE.messageBus.forEach(m => { if (m.to === agent || m.to === 'all') m.read = true; }); }

function log(agent, action, level = 'info', decision = '') {
  const e = { timestamp: new Date().toISOString(), agent, action, level, decision };
  STATE.actionLog.unshift(e);
  if (STATE.actionLog.length > 500) STATE.actionLog = STATE.actionLog.slice(0, 500);
  if (STATE.agents[agent]) {
    STATE.agents[agent].lastAction = action;
    if (decision) STATE.agents[agent].decision = decision;
  }
  console.log(`[${agent.toUpperCase()}] ${action}${decision ? ' → ' + decision : ''}`);
}

function addAlert(type, message, agent) {
  STATE.alerts.unshift({ id: Date.now(), type, message, agent, timestamp: new Date().toISOString(), resolved: false });
  if (STATE.alerts.length > 50) STATE.alerts = STATE.alerts.slice(0, 50);
}

function setAgent(name, status, extra = {}) {
  STATE.agents[name] = { ...STATE.agents[name], status, ...extra };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function callClaude(prompt, maxTokens = 1000) {
  if (!STATE.creds.anthropic || !fetch) throw new Error('Clé Anthropic manquante');
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': STATE.creds.anthropic, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
  }).then(r => r.json()).then(d => {
    const raw = (d.content || []).map(b => b.text || '').join('').trim();
    if (!raw) throw new Error('Réponse vide de Claude');
    return raw;
  });
}

function parseJSON(raw) {
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('Pas de JSON valide: ' + raw.slice(0, 100));
  return JSON.parse(raw.slice(s, e + 1));
}

function parseJSONArray(raw) {
  const s = raw.indexOf('['), e = raw.lastIndexOf(']');
  if (s === -1 || e === -1) return parseJSON(raw);
  return JSON.parse(raw.slice(s, e + 1));
}


// ════════════════════════════════════════════════════════════════
//  AGENT ANALYTICS — analyse les résultats et nourrit les autres
// ════════════════════════════════════════════════════════════════
async function runAnalytics() {
  if (!STATE.creds.tiktok || !fetch) return;
  setAgent('analytics', 'running');
  log('analytics', 'Analyse des publications TikTok');

  try {
    const res = await fetch(
      'https://open.tiktokapis.com/v2/video/list/?fields=id,title,create_time,like_count,comment_count,share_count,view_count',
      { method: 'POST', headers: { 'Authorization': 'Bearer ' + STATE.creds.tiktok, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ max_count: 20 }) }
    );
    const json = await res.json();
    const videos = json?.data?.videos || [];

    if (videos.length > 0) {
      STATE.analytics.videos     = videos;
      STATE.analytics.lastFetched = new Date().toISOString();
      STATE.analytics.avgViews   = Math.round(videos.reduce((a, v) => a + (v.view_count || 0), 0) / videos.length);
      STATE.analytics.avgShares  = Math.round(videos.reduce((a, v) => a + (v.share_count || 0), 0) / videos.length);
      const avgLikes = videos.reduce((a, v) => a + (v.like_count || 0), 0) / videos.length;
      STATE.analytics.engRate    = STATE.analytics.avgViews > 0 ? parseFloat((avgLikes / STATE.analytics.avgViews * 100).toFixed(2)) : 0;

      // Mettre à jour l'apprentissage : performances par sujet
      videos.forEach(v => {
        if (v.title) {
          const score = ((v.view_count || 0) * 1 + (v.share_count || 0) * 3 + (v.like_count || 0) * 2) / 100;
          STATE.apprentissage.performanceSujets[v.title] = {
            vues: v.view_count || 0, likes: v.like_count || 0,
            partages: v.share_count || 0, score: Math.round(score),
          };
        }
      });

      const topVideo = videos.reduce((a, b) => (a.view_count || 0) > (b.view_count || 0) ? a : b, videos[0]);
      log('analytics', `avg ${STATE.analytics.avgViews} vues, ${STATE.analytics.engRate}% eng, ${STATE.analytics.avgShares} partages`, 'success');
      log('analytics', `Top: "${topVideo.title}" (${topVideo.view_count} vues, ${topVideo.share_count} partages)`, 'success',
        `Apprentissage: ${Object.keys(STATE.apprentissage.performanceSujets).length} sujets analysés`);

      // Envoyer rapport aux agents
      msg('analytics', 'all', 'analytics_report', {
        avgViews: STATE.analytics.avgViews, avgShares: STATE.analytics.avgShares,
        engRate: STATE.analytics.engRate, topVideo: topVideo.title,
        performanceSujets: STATE.apprentissage.performanceSujets,
        heuresOptimales: STATE.apprentissage.heuresOptimales,
      }, 'high');

      // Signal si engagement faible
      if (STATE.analytics.engRate < 3 && videos.length >= 3) {
        msg('analytics', 'veille', 'strategy_signal', {
          signal: 'low_engagement', engRate: STATE.analytics.engRate,
          note: 'Engagement sous 3% — explorer nouvelles niches ou formats',
        }, 'high');
        log('analytics', 'Signal faible engagement → Agent Veille', 'warn');
      }

      // Signal partages élevés = bon format à répliquer
      if (STATE.analytics.avgShares > 50) {
        msg('analytics', 'script', 'format_signal', {
          signal: 'high_shares', topFormats: videos.sort((a, b) => (b.share_count || 0) - (a.share_count || 0)).slice(0, 3).map(v => v.title),
          note: 'Ces formats génèrent beaucoup de partages — s\'en inspirer',
        }, 'normal');
      }

      STATE.apprentissage.totalPublications = videos.length;
    }

    STATE.agents.analytics.cycleCount = (STATE.agents.analytics.cycleCount || 0) + 1;
    setAgent('analytics', 'idle', { lastRun: new Date().toISOString() });
  } catch(e) {
    log('analytics', 'Erreur: ' + e.message, 'error');
    setAgent('analytics', 'error');
    if (e.message.includes('401')) addAlert('api_limit', 'Token TikTok expiré — reconnexion requise sur Robot #5', 'analytics');
  }
}

// ════════════════════════════════════════════════════════════════
//  AGENT VEILLE — analyse tendances + propose 3 sujets optimaux
// ════════════════════════════════════════════════════════════════
async function runVeille() {
  if (!STATE.creds.anthropic) return;
  setAgent('veille', 'running');
  const signals   = getMsgs('veille', true); markRead('veille');
  const analytics = getMsgs('veille').find(m => m.type === 'analytics_report')?.data || {};

  // Sujets déjà publiés (mémoire longue durée)
  const dejaPublies = STATE.apprentissage.sujetsPublies.slice(-50).join(', ') || 'aucun';

  // Top performers connus
  const topPerfs = Object.entries(analytics.performanceSujets || {})
    .sort((a, b) => b[1].score - a[1].score).slice(0, 3)
    .map(([titre, stats]) => titre + ' (' + stats.vues + ' vues)').join(', ');

  const signalFaible = signals.some(m => m.data?.signal === 'low_engagement');

  log('veille', 'Analyse niches TikTok — aucun humain, haut engagement');

  const prompt = `Tu es expert TikTok spécialisé dans les contenus SANS apparition humaine à l'écran (voix-off uniquement).

CONTEXTE APPRENTISSAGE:
- Publications existantes: ${STATE.apprentissage.totalPublications}
- Taux engagement actuel: ${analytics.engRate || 0}%
- Top performers: ${topPerfs || 'aucun encore'}
- Signal: ${signalFaible ? 'FAIBLE engagement — changer de stratégie' : 'Engagement correct'}

CONTRAINTES ABSOLUES:
- Sujets avec VOIX-OFF UNIQUEMENT (aucun humain visible)
- Durée minimum 60 secondes (monétisation TikTok)
- Jamais ces sujets déjà traités: ${dejaPublies}
- Contenus qui génèrent vues + partages + abonnements

FORMATS qui performent le mieux sans humain:
- Histoires vraies mystérieuses (disparitions, survies)
- Faits historiques incroyables
- Phénomènes naturels inexpliqués
- Secrets et découvertes scientifiques
- Anecdotes historiques dramatiques

Propose exactement 3 sujets avec le meilleur potentiel viral. Pour chaque sujet:
- Score de viralité estimé sur 100
- Pourquoi ce sujet va performer
- Style visuel recommandé (époque, ambiance, couleurs)
- Ton vocal recommandé

JSON UNIQUEMENT:
{"sujets":[{"titre":"...","description":"histoire complète en 3 phrases","potentiel_viral":92,"pourquoi":"raison précise","style_visuel":"description détaillée du style visuel","ton":"dramatique|mysterieux|emotionnel|informatif","genre_voix":"homme|femme","periode":"epoque ou contexte visuel"}]}`;

  try {
    const raw    = await callClaude(prompt, 2000);
    const parsed = parseJSON(raw);

    if (!parsed.sujets || !Array.isArray(parsed.sujets)) throw new Error('Format JSON invalide');

    STATE.sujets = parsed.sujets.map(s => ({
      ...s, id: Date.now() + '_' + Math.random().toString(36).slice(2, 5),
      status: 'proposed', createdAt: new Date().toISOString(),
    }));

    const decision = `3 sujets proposés: ${parsed.sujets.map(s => s.titre + ' (' + s.potentiel_viral + '%)').join(' | ')}`;
    log('veille', 'Sujets sélectionnés', 'success', decision);

    msg('veille', 'script', 'sujets_ready', {
      sujets: STATE.sujets, engRate: analytics.engRate,
      note: 'Sujets choisis pour haut potentiel viral sans humain visible',
    }, 'high');

    STATE.agents.veille.cycleCount = (STATE.agents.veille.cycleCount || 0) + 1;
    setAgent('veille', 'idle', { lastRun: new Date().toISOString() });
  } catch(e) {
    log('veille', 'Erreur: ' + e.message, 'error');
    setAgent('veille', 'error');
  }
}

// ════════════════════════════════════════════════════════════════
//  AGENT SCRIPT — crée 3 scripts (min 60s) adaptés aux sujets
// ════════════════════════════════════════════════════════════════
async function runScript() {
  if (!STATE.creds.anthropic) return;

  const sujetsDispos = STATE.sujets.filter(s => s.status === 'proposed');
  if (!sujetsDispos.length) { log('script', 'Aucun sujet disponible — attente Agent Veille'); return; }
  if (STATE.scripts.filter(s => ['ready', 'audio_pending', 'audio_ready'].includes(s.status)).length >= 3) {
    log('script', 'Scripts suffisants en pipeline'); return;
  }

  setAgent('script', 'running');
  const sig = getMsgs('script', true); markRead('script');

  // Récupérer les formats qui marchent (signal Analytics)
  const formatSignal = sig.find(m => m.type === 'format_signal');
  const topFormats   = formatSignal?.data?.topFormats || [];

  log('script', 'Création de 3 scripts (min 60s) pour les sujets sélectionnés');

  for (const sujet of sujetsDispos.slice(0, 3)) {
    const prompt = `Tu es scénariste expert en contenus TikTok viraux SANS humain visible.

SUJET: ${sujet.titre}
DESCRIPTION: ${sujet.description}
TON: ${sujet.ton}
STYLE VISUEL: ${sujet.style_visuel}
PÉRIODE/CONTEXTE: ${sujet.periode || 'contemporain'}
GENRE VOIX RECOMMANDÉ: ${sujet.genre_voix}
${topFormats.length ? 'FORMATS QUI PERFORMENT: ' + topFormats.join(', ') : ''}

CONTRAINTES:
- Durée MINIMUM 60 secondes (monétisation TikTok obligatoire)
- Voix-off uniquement (aucune instruction pour montrer un visage)
- Structure: accroche 5s + développement 45s + révélation 8s + CTA 2s = 60s min
- CHAQUE PHRASE doit donner une INDICATION VISUELLE PRÉCISE pour générer une image
- Rythme: une scène visuelle différente toutes les 5 secondes

Format: le script doit être découpé en segments de 5 secondes avec pour chaque segment:
- Le texte exact dit par le narrateur
- La description précise de l'image à générer (en anglais, très détaillée pour IA)

JSON UNIQUEMENT:
{"titre":"...","segments":[{"debut":1,"fin":5,"narration":"texte exact 5s","image_prompt":"very detailed english description for AI image generation, specific scene, era, lighting, mood","mots_cles_visuels":["keyword1","keyword2"]},{"debut":6,"fin":10,"narration":"texte exacte 5s suivantes","image_prompt":"...","mots_cles_visuels":["..."]},...],"hashtags":["tag1","tag2","tag3","tag4","tag5"],"ton_narrateur":"dramatique|grave|mysterieux|emotionnel","genre_voix":"homme|femme","note_viralite":88,"conseil_voix":"instructions précises pour le narrateur"}`;

    try {
      const raw    = await callClaude(prompt, 4000);
      const parsed = parseJSON(raw);

      if (!parsed.segments || !Array.isArray(parsed.segments)) throw new Error('Segments manquants');

      // Vérifier durée min 60s
      const dureeEstimee = parsed.segments.length * 5;
      if (dureeEstimee < 60) {
        log('script', `Script "${parsed.titre}" trop court (${dureeEstimee}s) — ignoré`, 'warn');
        continue;
      }

      const script = {
        ...parsed, id: sujet.id, sujetId: sujet.id,
        status: 'ready', niche: sujet.titre,
        createdAt: new Date().toISOString(),
        dureeEstimee,
      };
      STATE.scripts.push(script);
      sujet.status = 'scripted';

      log('script', `Script "${parsed.titre}" — ${parsed.segments.length} segments (${dureeEstimee}s)`, 'success',
        `Ton: ${parsed.ton_narrateur}, Voix: ${parsed.genre_voix}`);

      msg('script', 'voix', 'script_ready', {
        scriptId: script.id, titre: script.titre,
        ton: script.ton_narrateur, genre_voix: script.genre_voix,
        conseil_voix: script.conseil_voix, segments: script.segments.length,
      }, 'high');

      await sleep(1500);
    } catch(e) {
      log('script', 'Erreur script "' + sujet.titre + '": ' + e.message, 'error');
    }
  }

  STATE.agents.script.cycleCount = (STATE.agents.script.cycleCount || 0) + 1;
  setAgent('script', 'idle', { lastRun: new Date().toISOString() });
}


// ════════════════════════════════════════════════════════════════
//  AGENT VOIX-OFF — choisit la voix adaptée + génère l'audio
// ════════════════════════════════════════════════════════════════
async function runVoix() {
  if (!STATE.creds.elevenlabs || !fetch) {
    if (!STATE.creds.elevenlabs) addAlert('payment', 'Clé ElevenLabs manquante — Agent Voix-off bloqué', 'voix');
    return;
  }

  const scriptsReady = STATE.scripts.filter(s => s.status === 'ready');
  if (!scriptsReady.length) { log('voix', 'Aucun script prêt — attente Agent Script'); return; }

  setAgent('voix', 'running');
  const sig = getMsgs('voix', true); markRead('voix');

  for (const script of scriptsReady.slice(0, 2)) {
    log('voix', 'Sélection de la voix optimale pour: "' + script.titre + '"');
    script.status = 'audio_pending';

    // Choisir la meilleure voix selon le ton/genre + apprentissage
    const voixChoisie = choisirVoix(script.ton_narrateur, script.genre_voix, script.conseil_voix);
    log('voix', 'Voix choisie: ' + voixChoisie.nom + ' (' + voixChoisie.genre + ')', 'info',
      'Adapté au ton: ' + script.ton_narrateur + ', genre: ' + script.genre_voix);

    // Assembler le texte complet depuis les segments
    const texteComplet = script.segments.map(s => s.narration).join(' ');

    // Paramètres voix adaptés au ton
    const voiceSettings = getVoiceSettings(script.ton_narrateur);

    try {
      const res = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voixChoisie.id, {
        method: 'POST',
        headers: { 'xi-api-key': STATE.creds.elevenlabs, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
        body: JSON.stringify({ text: texteComplet, model_id: 'eleven_multilingual_v2', voice_settings: voiceSettings }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 401 || res.status === 403) {
          addAlert('payment', 'Clé ElevenLabs invalide ou quota insuffisant — vérifier abonnement', 'voix');
          script.status = 'ready'; break;
        }
        throw new Error('ElevenLabs ' + res.status + ': ' + JSON.stringify(err));
      }

      const buf   = await res.buffer();
      const slug  = script.titre.replace(/[^a-z0-9]/gi, '_').slice(0, 25).toLowerCase();
      const fname = 'vo_' + Date.now() + '_' + slug + '.mp3';
      const fpath = path.join('/tmp/audio', fname);
      fs.writeFileSync(fpath, buf);

      // Estimer durée par taille (128kbps ElevenLabs)
      const dureeEstimee = Math.round((buf.length * 8) / (128 * 1000));

      STATE.audioFiles.push({
        scriptId: script.id, filename: fname, path: fpath,
        size: buf.length, duration: dureeEstimee,
        voixId: voixChoisie.id, voixNom: voixChoisie.nom,
      });
      script.status    = 'audio_ready';
      script.audioFile = fname;
      script.audioDuration = dureeEstimee;

      log('voix', 'Voix-off générée: ' + fname + ' (' + Math.round(buf.length/1024) + 'Ko, ~' + dureeEstimee + 's)', 'success',
        'Voix ' + voixChoisie.nom + ' — ' + script.segments.length + ' segments à illustrer');

      msg('voix', 'montage', 'audio_ready', {
        scriptId: script.id, titre: script.titre,
        audioFile: fname, duration: dureeEstimee,
        segments: script.segments, // Passer les segments avec image_prompt
        voixNom: voixChoisie.nom,
      }, 'high');

      // Mettre à jour l'apprentissage sur les voix
      if (!STATE.apprentissage.voixPerformantes[voixChoisie.id]) {
        STATE.apprentissage.voixPerformantes[voixChoisie.id] = { nom: voixChoisie.nom, utilisations: 0, scoreTotal: 0 };
      }
      STATE.apprentissage.voixPerformantes[voixChoisie.id].utilisations++;

      await sleep(1000);
    } catch(e) {
      script.status = 'ready';
      log('voix', 'Erreur: ' + e.message, 'error');
      if (e.message.includes('429') || e.message.includes('quota')) {
        addAlert('payment', 'Quota ElevenLabs dépassé — vérifier abonnement', 'voix'); break;
      }
    }
  }

  STATE.agents.voix.cycleCount = (STATE.agents.voix.cycleCount || 0) + 1;
  setAgent('voix', 'idle', { lastRun: new Date().toISOString() });
}

function choisirVoix(ton, genre, conseil) {
  const voixList = Object.entries(VOIX).map(([id, v]) => ({ id, ...v }));

  // Filtrer par genre si spécifié
  let candidates = genre === 'femme'
    ? voixList.filter(v => v.genre === 'femme')
    : genre === 'homme'
    ? voixList.filter(v => v.genre === 'homme')
    : voixList;

  if (!candidates.length) candidates = voixList;

  // Choisir selon le ton
  const tonMap = {
    'dramatique': ['Adam', 'Josh'],
    'mysterieux':  ['Rachel', 'Adam'],
    'emotionnel':  ['Bella', 'Elli'],
    'grave':       ['Josh', 'Adam'],
    'chaleureux':  ['Antoni', 'Rachel'],
    'informatif':  ['Rachel', 'Antoni'],
  };
  const preferred = (tonMap[ton] || tonMap['dramatique']);
  const match = candidates.find(v => preferred.includes(v.nom)) || candidates[0];

  // Vérifier l'apprentissage — favoriser les voix performantes
  const voixPerfs = STATE.apprentissage.voixPerformantes;
  if (Object.keys(voixPerfs).length > 0) {
    const bestPerf = candidates.filter(v => voixPerfs[v.id])
      .sort((a, b) => {
        const sa = voixPerfs[a.id]?.scoreTotal / (voixPerfs[a.id]?.utilisations || 1) || 0;
        const sb = voixPerfs[b.id]?.scoreTotal / (voixPerfs[b.id]?.utilisations || 1) || 0;
        return sb - sa;
      })[0];
    if (bestPerf && voixPerfs[bestPerf.id].utilisations >= 2) return bestPerf;
  }

  return match || voixList[0];
}

function getVoiceSettings(ton) {
  const settings = {
    'dramatique': { stability: 0.4, similarity_boost: 0.8, style: 0.7, use_speaker_boost: true },
    'mysterieux':  { stability: 0.5, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true },
    'emotionnel':  { stability: 0.35, similarity_boost: 0.85, style: 0.8, use_speaker_boost: true },
    'grave':       { stability: 0.6, similarity_boost: 0.7, style: 0.4, use_speaker_boost: true },
    'informatif':  { stability: 0.65, similarity_boost: 0.7, style: 0.3, use_speaker_boost: false },
  };
  return settings[ton] || settings['dramatique'];
}


// ════════════════════════════════════════════════════════════════
//  AGENT MONTAGE — 1 image par 5s, cohérente avec la narration
// ════════════════════════════════════════════════════════════════

async function downloadImagePollinations(prompt, outputPath, segIndex, totalSeg) {
  if (!fetch) return false;

  // Prompt enrichi pour cohérence visuelle avec la narration
  const styleExtra = 'cinematic vertical 9:16, ultra realistic, high quality, dramatic lighting, no humans faces visible, atmospheric';
  const fullPrompt = (prompt + ', ' + styleExtra).slice(0, 300);
  const encoded    = encodeURIComponent(fullPrompt);

  for (let attempt = 0; attempt < 3; attempt++) {
    const seed = Math.floor(Math.random() * 99999) + (segIndex * 1000); // Seed différent par segment
    const url  = 'https://image.pollinations.ai/prompt/' + encoded + '?width=1080&height=1920&seed=' + seed + '&nologo=true&enhance=true';
    try {
      const res = await fetch(url, { timeout: 25000 });
      if (res.ok) {
        const buf = await res.buffer();
        if (buf.length > 5000) { // Vérifier que c'est une vraie image
          fs.writeFileSync(outputPath, buf);
          return true;
        }
      }
    } catch(e) {
      if (attempt < 2) await sleep(2000);
    }
  }
  return false;
}

function creerImageFallback(outputPath) {
  // JPEG noir minimal valide
  const jpegHex = 'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e272022' +
    '2c231c1c2837292c30313434341f27393d383032' + '3c2e333434 32ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda00080101000003f00000' +
    'ffd9';
  try {
    fs.writeFileSync(outputPath, Buffer.from(jpegHex.replace(/\s/g,''), 'hex'));
  } catch(e) {
    fs.writeFileSync(outputPath, Buffer.alloc(1000, 0));
  }
}

function getAudioDuration(audioPath) {
  return new Promise(resolve => {
    if (!ffmpeg) {
      try { const s = fs.statSync(audioPath).size; resolve(Math.max(30, Math.min(180, (s * 8) / (128 * 1000)))); }
      catch(e) { resolve(60); }
      return;
    }
    ffmpeg.ffprobe(audioPath, (err, meta) => {
      if (!err && meta?.format?.duration) resolve(meta.format.duration);
      else {
        try { const s = fs.statSync(audioPath).size; resolve(Math.max(30, Math.min(180, (s * 8) / (128 * 1000)))); }
        catch(e) { resolve(60); }
      }
    });
  });
}

function creerSegmentVideoFFmpeg(imgPath, duration, outputPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpeg) { reject(new Error('FFmpeg non disponible')); return; }
    // Pas de zoompan — trop instable sur Railway. Scale + crop simple et fiable.
    ffmpeg(imgPath)
      .inputOptions(['-loop 1', '-t ' + duration])
      .videoFilters([
        'scale=1080:1920:force_original_aspect_ratio=increase',
        'crop=1080:1920:0:0',
      ])
      .outputOptions([
        '-c:v libx264', '-preset ultrafast', '-tune stillimage',
        '-pix_fmt yuv420p', '-t ' + duration, '-r 25',
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', function(err) {
        console.warn('[Montage] Segment retry:', err.message.slice(0,60));
        // Retry avec paramètres encore plus simples
        ffmpeg(imgPath)
          .inputOptions(['-loop 1', '-t ' + duration])
          .outputOptions([
            '-vf', 'scale=1080:1920',
            '-c:v libx264', '-preset ultrafast', '-pix_fmt yuv420p',
            '-t ' + duration, '-r 25',
          ])
          .output(outputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      })
      .run();
  });
}

function assemblerVideoFinale(segmentPaths, audioPath, outputPath, segments) {
  return new Promise((resolve, reject) => {
    if (!ffmpeg) { reject(new Error('FFmpeg non disponible')); return; }
    const listFile = outputPath.replace('.mp4', '_list.txt');
    fs.writeFileSync(listFile, segmentPaths.map(p => "file '" + p + "'").join('\n'));
    ffmpeg()
      .input(listFile).inputOptions(['-f concat', '-safe 0'])
      .input(audioPath)
      .outputOptions([
        '-c:v libx264', '-preset ultrafast', '-pix_fmt yuv420p',
        '-c:a aac', '-b:a 128k', '-shortest', '-movflags +faststart',
      ])
      .output(outputPath)
      .on('end', () => { try { fs.unlinkSync(listFile); } catch(e) {} resolve(); })
      .on('error', reject)
      .run();
  });
}

function prochainCreneau() {
  const now = new Date(); const hours = STATE.apprentissage.heuresOptimales || [8, 19, 21];
  for (let d = 0; d <= 3; d++) {
    for (const h of hours) {
      const c = new Date(now); c.setDate(c.getDate() + d); c.setHours(h, 0, 0, 0);
      if (c > now) {
        const busy = Object.values(STATE.publishQueue).some(v => v.scheduledAt && v.status !== 'published' && Math.abs(new Date(v.scheduledAt) - c) < 3600000);
        if (!busy) return c;
      }
    }
  }
  return new Date(Date.now() + 3 * 3600000);
}

async function runMontage() {
  const scriptsReady = STATE.scripts.filter(s => s.status === 'audio_ready' && s.audioFile && s.segments);
  if (!scriptsReady.length) { log('montage', 'Aucun audio prêt — attente Agent Voix-off'); return; }

  setAgent('montage', 'running');
  const sig = getMsgs('montage', true); markRead('montage');

  for (const script of scriptsReady.slice(0, 1)) {
    log('montage', 'Montage de: "' + script.titre + '" — ' + script.segments.length + ' images à générer');
    script.status = 'video_pending';

    const audioPath = path.join('/tmp/audio', script.audioFile);
    if (!fs.existsSync(audioPath)) { script.status = 'audio_ready'; continue; }

    try {
      const audioDuration = await getAudioDuration(audioPath);
      log('montage', 'Durée audio réelle: ' + Math.round(audioDuration) + 's');

      // Utiliser les segments du script (déjà découpés en 5s avec image_prompt)
      const segments = script.segments;
      // Chaque segment = 5s fixes, sauf le dernier qui prend le reste
      const DUR_SEG = 5;
      const durParSeg = DUR_SEG; // 5 secondes par image

      log('montage', 'Génération ' + segments.length + ' images IA contextuelles (Pollinations.ai)...');

      // Télécharger les images en parallèle par batch de 3
      const imagePaths = new Array(segments.length).fill(null);
      for (let b = 0; b < segments.length; b += 3) {
        const end = Math.min(b + 3, segments.length);
        await Promise.all(
          segments.slice(b, end).map(async (seg, j) => {
            const idx     = b + j;
            const imgPath = path.join('/tmp/images', script.id + '_' + idx + '.jpg');
            const ok      = await downloadImagePollinations(seg.image_prompt, imgPath, idx, segments.length);
            if (ok) {
              imagePaths[idx] = imgPath;
              log('montage', 'Image ' + (idx + 1) + '/' + segments.length + ': "' + seg.narration.slice(0, 40) + '..."');
            } else {
              creerImageFallback(imgPath);
              imagePaths[idx] = imgPath;
              log('montage', 'Image ' + (idx + 1) + ' → fallback (Pollinations indisponible)', 'warn');
            }
          })
        );
        await sleep(800);
      }

      if (!ffmpeg) {
        // Sans FFmpeg : sauvegarder les images et indiquer que la vidéo n'est pas assemblée
        log('montage', 'FFmpeg non disponible — images générées mais assemblage impossible', 'warn');
        addAlert('api_limit', 'FFmpeg non disponible sur Railway — impossible d\'assembler la vidéo MP4', 'montage');
        script.status = 'audio_ready'; continue;
      }

      // Créer les segments vidéo (image + durée)
      log('montage', 'Encodage ' + segments.length + ' segments vidéo...');
      const segPaths = [];
      for (let i = 0; i < segments.length; i++) {
        const sp = path.join('/tmp/segments', script.id + '_seg' + i + '.mp4');
        // Dernier segment : durée restante pour correspondre exactement à l'audio
        const segDur = (i === segments.length - 1)
          ? Math.max(3, audioDuration - (segments.length - 1) * DUR_SEG)
          : DUR_SEG;
        await creerSegmentVideoFFmpeg(imagePaths[i], segDur, sp);
        segPaths.push(sp);
        log('montage', 'Segment ' + (i+1) + '/' + segments.length + ' encodé (' + segDur.toFixed(1) + 's)');
      }

      // Assembler avec la voix-off
      log('montage', 'Assemblage final (images + voix-off synchronisée)...');
      const slug    = script.titre.replace(/[^a-z0-9]/gi, '_').slice(0, 25).toLowerCase();
      const outFile = 'tiktok_' + Date.now() + '_' + slug + '.mp4';
      const outPath = path.join('/tmp/videos', outFile);
      await assemblerVideoFinale(segPaths, audioPath, outPath, segments);

      const stat = fs.statSync(outPath);
      log('montage', 'Vidéo créée: ' + outFile + ' (' + Math.round(stat.size / 1024 / 1024 * 10) / 10 + 'Mo)', 'success',
        segments.length + ' images, ' + Math.round(audioDuration) + 's, voix synchronisée');

      // Nettoyer les fichiers temp
      [...imagePaths, ...segPaths].forEach(p => { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch(e) {} });

      const scheduledAt = prochainCreneau();
      STATE.videoFiles.push({ scriptId: script.id, filename: outFile, path: outPath, size: stat.size, duration: audioDuration, createdAt: new Date().toISOString() });
      script.status    = 'video_ready';
      script.videoFile = outFile;

      STATE.publishQueue[outFile] = {
        titre: script.titre, niche: script.niche,
        caption: segments.map(s => s.narration).join(' ').slice(0, 300),
        hashtags: script.hashtags || [], filePath: outPath, fileSize: stat.size,
        scheduledAt, status: 'pending_approval',
        addedAt: new Date().toISOString(), error: null,
        autoApproveAt: new Date(Date.now() + 2 * 3600000).toISOString(),
      };

      // Auto-approbation dans 2h
      setTimeout(() => {
        const v = STATE.publishQueue[outFile];
        if (v && v.status === 'pending_approval') {
          v.status = 'scheduled';
          log('montage', 'Auto-approuvé: "' + v.titre + '" (2h sans intervention)', 'info');
        }
      }, 2 * 3600000);

      msg('montage', 'pub', 'video_ready', { titre: script.titre, videoFile: outFile, scheduledAt }, 'high');

    } catch(e) {
      script.status = 'audio_ready';
      log('montage', 'Erreur: ' + e.message, 'error');
    }
  }

  STATE.agents.montage.cycleCount = (STATE.agents.montage.cycleCount || 0) + 1;
  setAgent('montage', 'idle', { lastRun: new Date().toISOString() });
}


// ════════════════════════════════════════════════════════════════
//  AGENT PUBLICATION — publie aux heures optimales
// ════════════════════════════════════════════════════════════════
function runPub() {
  const sig = getMsgs('pub', true); markRead('pub');
  // Mise à jour horaires depuis Analytics
  const anaSig = sig.find(m => m.type === 'analytics_report');
  if (anaSig?.data?.heuresOptimales) {
    STATE.apprentissage.heuresOptimales = anaSig.data.heuresOptimales;
    log('pub', 'Horaires mis à jour: ' + STATE.apprentissage.heuresOptimales.join('h, ') + 'h');
  }
  const pending = Object.values(STATE.publishQueue).filter(v => v.status === 'scheduled').length;
  const waiting = Object.values(STATE.publishQueue).filter(v => v.status === 'pending_approval').length;
  log('pub', pending + ' planifiée(s), ' + waiting + ' en attente de validation');
  Object.entries(STATE.publishQueue).forEach(([fn, v]) => {
    if (v.status === 'scheduled' && v.scheduledAt && new Date(v.scheduledAt) <= new Date()) {
      log('pub', 'Heure atteinte → publication de "' + v.titre + '"');
      publierVideo(fn);
    }
  });
  STATE.agents.pub.cycleCount = (STATE.agents.pub.cycleCount || 0) + 1;
  setAgent('pub', 'idle', { lastRun: new Date().toISOString() });
}

async function publierVideo(filename) {
  const v = STATE.publishQueue[filename];
  if (!v || !STATE.creds.tiktok || !fetch) return;
  v.status = 'uploading'; setAgent('pub', 'running');
  log('pub', 'Upload TikTok: "' + v.titre + '"');
  try {
    if (!fs.existsSync(v.filePath)) throw new Error('Fichier vidéo introuvable: ' + v.filePath);
    const buf  = fs.readFileSync(v.filePath);
    const size = buf.length;
    const hashtags = (v.hashtags || []).map(h => '#' + h.replace('#', '')).join(' ');
    const cap  = (v.caption || v.titre || '').slice(0, 150) + '\n\n' + hashtags;

    const init = await fetch('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + STATE.creds.tiktok, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({
        post_info: { title: cap.slice(0, 150), privacy_level: 'SELF_ONLY', disable_duet: false, disable_comment: false, disable_stitch: false },
        source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: size, total_chunk_count: 1 },
      }),
    });
    const id = await init.json();
    if (!id?.data?.publish_id) throw new Error('Init TikTok échoué: ' + JSON.stringify(id?.error));
    v.tiktokPublishId = id.data.publish_id;

    await fetch(id.data.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-' + (size-1) + '/' + size, 'Content-Length': String(size) },
      body: buf,
    });

    for (let i = 0; i < 12; i++) {
      await sleep(5000);
      const st  = await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + STATE.creds.tiktok, 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ publish_id: id.data.publish_id }),
      });
      const sd = await st.json(); const status = sd?.data?.status;
      if (status === 'PUBLISH_COMPLETE' || status === 'SEND_TO_USER_INBOX') {
        v.status = 'published'; v.publishedAt = new Date().toISOString();
        log('pub', 'Publié sur TikTok: "' + v.titre + '"', 'success',
          'Hashtags: ' + (v.hashtags || []).slice(0, 3).join(', '));
        msg('pub', 'analytics', 'video_published', { titre: v.titre, niche: v.niche, publishId: id.data.publish_id }, 'high');
        // Ajouter au registre des sujets publiés
        STATE.apprentissage.sujetsPublies.push(v.titre);
        try { fs.unlinkSync(v.filePath); } catch(e) {}
        break;
      }
      if (status === 'FAILED') throw new Error('TikTok a refusé la vidéo: ' + JSON.stringify(sd?.data));
    }
  } catch(e) {
    v.status = 'error'; v.error = e.message;
    log('pub', 'Erreur: ' + e.message, 'error');
    if (e.message.includes('401')) addAlert('api_limit', 'Token TikTok expiré — reconnexion sur Robot #5', 'pub');
  }
  setAgent('pub', 'idle', { lastRun: new Date().toISOString() });
}

// ════════════════════════════════════════════════════════════════
//  ORCHESTRATEUR — cycle toutes les heures
// ════════════════════════════════════════════════════════════════
async function runOrchestrator() {
  log('orchestrateur', '════ CYCLE ORCHESTRATEUR ════');
  try { await runAnalytics();  } catch(e) { log('orchestrateur', 'Analytics: ' + e.message, 'error'); }
  await sleep(2000);
  try { await runVeille();     } catch(e) { log('orchestrateur', 'Veille: ' + e.message, 'error'); }
  await sleep(2000);
  try { await runScript();     } catch(e) { log('orchestrateur', 'Script: ' + e.message, 'error'); }
  await sleep(2000);
  try { await runVoix();       } catch(e) { log('orchestrateur', 'Voix: ' + e.message, 'error'); }
  await sleep(2000);
  try { await runMontage();    } catch(e) { log('orchestrateur', 'Montage: ' + e.message, 'error'); }
  await sleep(1000);
  try { runPub();              } catch(e) { log('orchestrateur', 'Pub: ' + e.message, 'error'); }
  log('orchestrateur', '════ CYCLE TERMINÉ ════', 'success');
}

// Cron — cycle toutes les heures
if (cron) {
  cron.schedule('0 * * * *', runOrchestrator);
  cron.schedule('*/5 * * * *', () => {
    Object.entries(STATE.publishQueue).forEach(([fn, v]) => {
      if (v.status === 'scheduled' && v.scheduledAt && new Date(v.scheduledAt) <= new Date()) publierVideo(fn);
    });
  });
  log('system', 'Cron orchestrateur configuré (toutes les heures)');
}

// ════════════════════════════════════════════════════════════════
//  ROUTES API
// ════════════════════════════════════════════════════════════════
app.get('/', (req, res) => res.json({ status: 'ok', message: 'TikTok Agent Suite v4 — 6 Agents IA', version: '4.0.0', ffmpeg: !!ffmpeg, cron: !!cron }));

app.get('/dashboard', (req, res) => res.json({
  agents:   STATE.agents,
  strategy: STATE.apprentissage,
  analytics: { ...STATE.analytics, videos: STATE.analytics.videos.slice(0, 5) },
  alerts:   STATE.alerts.filter(a => !a.resolved),
  sujets:   STATE.sujets.slice(0, 6),
  scripts:  STATE.scripts.slice(0, 10).map(s => ({ id: s.id, titre: s.titre, status: s.status, niche: s.niche, segments: s.segments?.length || 0, createdAt: s.createdAt })),
  audioFiles:   STATE.audioFiles.slice(0, 10).map(a => ({ scriptId: a.scriptId, filename: a.filename, size: a.size, duration: a.duration, voixNom: a.voixNom })),
  videoFiles:   STATE.videoFiles.slice(0, 10).map(v => ({ scriptId: v.scriptId, filename: v.filename, size: v.size, duration: v.duration, createdAt: v.createdAt })),
  publishQueue: Object.fromEntries(Object.entries(STATE.publishQueue).map(([k, v]) => [k, { titre: v.titre, status: v.status, scheduledAt: v.scheduledAt, publishedAt: v.publishedAt, error: v.error, autoApproveAt: v.autoApproveAt }])),
  messageBus:   STATE.messageBus.slice(0, 40),
  actionLog:    STATE.actionLog.slice(0, 60),
  credentials:  { tiktok: !!STATE.creds.tiktok, anthropic: !!STATE.creds.anthropic, elevenlabs: !!STATE.creds.elevenlabs },
}));

app.post('/configure', (req, res) => {
  const { token, anthropic_key, elevenlabs_key, voice_id } = req.body;
  if (token)          { STATE.creds.tiktok      = token;          log('system', 'Token TikTok configuré', 'success'); }
  if (anthropic_key)  { STATE.creds.anthropic   = anthropic_key;  log('system', 'Clé Anthropic configurée', 'success'); }
  if (elevenlabs_key) { STATE.creds.elevenlabs  = elevenlabs_key; log('system', 'Clé ElevenLabs configurée', 'success'); }
  if (voice_id)         STATE.creds.voiceId     = voice_id;
  res.json({ ok: true, credentials: { tiktok: !!STATE.creds.tiktok, anthropic: !!STATE.creds.anthropic, elevenlabs: !!STATE.creds.elevenlabs } });
});

app.get('/progress', (req, res) => {
  const steps = [
    { agent: 'analytics', label: 'Analyse TikTok',     done: (STATE.agents.analytics?.cycleCount || 0) > 0 },
    { agent: 'veille',    label: 'Sujets proposés',    done: STATE.sujets.length > 0 },
    { agent: 'script',    label: 'Scripts créés',      done: STATE.scripts.length > 0 },
    { agent: 'voix',      label: 'Voix-off générée',   done: STATE.audioFiles.length > 0 },
    { agent: 'montage',   label: 'Vidéo montée',       done: STATE.videoFiles.length > 0 },
    { agent: 'pub',       label: 'Publication TikTok', done: Object.values(STATE.publishQueue).some(v => v.status === 'published') },
  ];
  const current = Object.entries(STATE.agents).find(([, a]) => a.status === 'running')?.[0] || null;
  const done    = steps.filter(s => s.done).length;
  res.json({ steps, currentAgent: current, doneCount: done, total: steps.length, pct: Math.round(done / steps.length * 100) });
});

app.post('/video/:f/approve', (req, res) => {
  const v = STATE.publishQueue[req.params.f];
  if (!v) return res.status(404).json({ error: 'Introuvable' });
  v.status = 'scheduled'; v.approvedAt = new Date().toISOString();
  log('system', 'Approuvé: "' + v.titre + '"', 'success');
  res.json({ ok: true, scheduledAt: v.scheduledAt });
});

app.post('/video/:f/reject', async (req, res) => {
  const v = STATE.publishQueue[req.params.f];
  if (!v) return res.status(404).json({ error: 'Introuvable' });
  const titre = v.titre;
  try { if (fs.existsSync(v.filePath)) fs.unlinkSync(v.filePath); } catch(e) {}
  delete STATE.publishQueue[req.params.f];
  STATE.videoFiles = STATE.videoFiles.filter(vf => vf.filename !== req.params.f);
  const sc = STATE.scripts.find(s => s.titre === titre);
  if (sc) { sc.status = 'rejected'; }
  STATE.scripts = STATE.scripts.filter(s => s.status !== 'rejected');
  const sj = STATE.sujets.find(s => s.titre === titre || sc?.niche === s.titre);
  if (sj) sj.status = 'proposed'; // Remettre le sujet en attente de nouveau script
  log('system', 'Rejeté: "' + titre + '" — régénération', 'warn');
  msg('system', 'script', 'content_rejected', { titre }, 'high');
  res.json({ ok: true });
  setTimeout(async () => { await runScript(); await runVoix(); }, 3000);
});

app.get('/video/:filename', (req, res) => {
  const fp = path.join('/tmp/videos', req.params.filename.replace(/\.\./g, ''));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Introuvable' });
  const size  = fs.statSync(fp).size;
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end   = parts[1] ? parseInt(parts[1], 10) : size - 1;
    res.writeHead(206, { 'Content-Range': 'bytes ' + start + '-' + end + '/' + size, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': 'video/mp4' });
    fs.createReadStream(fp, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
    fs.createReadStream(fp).pipe(res);
  }
});

app.get('/videos/list', (req, res) => {
  try {
    const dir = '/tmp/videos';
    if (!fs.existsSync(dir)) return res.json({ videos: [] });
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.mp4')).map(f => {
      const fp = path.join(dir, f); const st = fs.statSync(fp);
      const pq = STATE.publishQueue[f]; const sc = STATE.scripts.find(s => s.videoFile === f);
      return { filename: f, size: st.size, createdAt: st.birthtime, titre: sc?.titre || pq?.titre || f, status: pq?.status || 'ready', scheduledAt: pq?.scheduledAt || null, autoApproveAt: pq?.autoApproveAt || null };
    }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ videos: files });
  } catch(e) { res.json({ videos: [] }); }
});

app.get('/sujets',   (req, res) => res.json({ sujets: STATE.sujets }));
app.get('/scripts',  (req, res) => res.json({ scripts: STATE.scripts }));
app.get('/status',   (req, res) => res.json({ ok: true, queue: STATE.publishQueue, token_set: !!STATE.creds.tiktok }));
app.get('/alerts',   (req, res) => res.json({ alerts: STATE.alerts }));
app.post('/alerts/:id/resolve', (req, res) => { const a = STATE.alerts.find(a => a.id === parseInt(req.params.id)); if (a) a.resolved = true; res.json({ ok: true }); });
app.get('/apprentissage', (req, res) => res.json({ apprentissage: STATE.apprentissage }));

app.post('/run/:agent', async (req, res) => {
  const { agent } = req.params;
  res.json({ ok: true, message: 'Agent ' + agent + ' démarré' });
  if      (agent === 'analytics') await runAnalytics();
  else if (agent === 'veille')    await runVeille();
  else if (agent === 'script')    await runScript();
  else if (agent === 'voix')      await runVoix();
  else if (agent === 'montage')   await runMontage();
  else if (agent === 'pub')       runPub();
  else if (agent === 'all')       await runOrchestrator();
});

// Upload manuel depuis Robot #5
const upload2 = multer ? multer({ dest: '/tmp/uploads/', limits: { fileSize: 200 * 1024 * 1024 } }) : null;
if (upload2) {
  app.post('/schedule', upload2.single('video'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Fichier requis' });
    const { titre, caption, hashtags, scheduled_at } = req.body;
    const fn = req.file.originalname || req.file.filename;
    const sa = scheduled_at ? new Date(scheduled_at) : prochainCreneau();
    STATE.publishQueue[fn] = { titre, caption, filePath: req.file.path, fileSize: req.file.size, hashtags: hashtags ? JSON.parse(hashtags) : [], scheduledAt: sa, status: 'scheduled', addedAt: new Date().toISOString(), error: null };
    if (sa > new Date()) { setTimeout(() => publierVideo(fn), sa - new Date()); }
    else setImmediate(() => publierVideo(fn));
    res.json({ ok: true, filename: fn, scheduledAt: sa });
  });
}

// ════════════════════════════════════════════════════════════════
//  DÉMARRAGE
// ════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log('\n🤖 TikTok Agent Suite v4 — 6 Agents IA Autonomes');
  console.log('   Port:   ' + PORT);
  console.log('   FFmpeg: ' + (ffmpeg ? '✅ Disponible' : '❌ Non disponible (montage limité)'));
  console.log('   Cron:   ' + (cron ? '✅ Actif' : '❌ Inactif'));
  console.log('   Agents: Veille | Script | Voix | Montage | Publication | Analytics\n');
  log('system', 'Serveur démarré — 6 agents prêts', 'success');
  // Premier cycle dans 1 minute
  setTimeout(runOrchestrator, 60000);
});
