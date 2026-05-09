// ════════════════════════════════════════════════════════════════
//  TIKTOK AGENT SUITE v3 — Démarrage sécurisé
// ════════════════════════════════════════════════════════════════
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Chargement optionnel des modules lourds
let fetch    = null;
let multer   = null;
let cron     = null;
let ffmpeg   = null;

try { fetch  = require('node-fetch');            console.log('[OK] node-fetch'); } catch(e) { console.warn('[WARN] node-fetch:', e.message); }
try { multer = require('multer');                console.log('[OK] multer'); }     catch(e) { console.warn('[WARN] multer:', e.message); }
try { cron   = require('node-cron');             console.log('[OK] node-cron'); }  catch(e) { console.warn('[WARN] node-cron:', e.message); }
try {
  ffmpeg = require('fluent-ffmpeg');
  const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
  ffmpeg.setFfmpegPath(ffmpegPath);
  console.log('[OK] ffmpeg:', ffmpegPath);
} catch(e) { console.warn('[WARN] ffmpeg non disponible:', e.message); ffmpeg = null; }

// Dossiers de travail
['/tmp/audio','/tmp/images','/tmp/videos','/tmp/segments','/tmp/uploads'].forEach(d => {
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch(e) {}
});

// Upload (si multer disponible)
const uploadMiddleware = multer
  ? multer({ dest: '/tmp/uploads/', limits: { fileSize: 200*1024*1024 } })
  : { single: () => (req,res,next) => next() };

// ════════════════════════════════════════════════════════════════
//  ÉTAT GLOBAL
// ════════════════════════════════════════════════════════════════
const STATE = {
  creds: { tiktok: '', anthropic: '', elevenlabs: '', voiceId: 'pNInz6obpgDQGcFmaJgB' },
  strategy: { niche: 'Storytelling', ton: 'Dramatique', postingFrequency: 1, bestHours: [8,19,21], topHashtags: [], visualStyle: 'cinematique', lastUpdated: null },
  scripts: [], audioFiles: [], videoFiles: [], publishQueue: {},
  analytics: { videos: [], avgViews: 0, engRate: 0, lastFetched: null },
  agents: {
    veille:    { status:'idle', lastRun:null, cycleCount:0, lastAction:'' },
    contenu:   { status:'idle', lastRun:null, cycleCount:0, lastAction:'' },
    voix:      { status:'idle', lastRun:null, cycleCount:0, lastAction:'' },
    montage:   { status:'idle', lastRun:null, cycleCount:0, lastAction:'' },
    pub:       { status:'idle', lastRun:null, cycleCount:0, lastAction:'' },
    analytics: { status:'idle', lastRun:null, cycleCount:0, lastAction:'' },
  },
  messageBus: [], alerts: [], actionLog: [],
};

// ════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════
function msg(from, to, type, data, priority='normal') {
  const m = { id:`${Date.now()}_${Math.random().toString(36).slice(2,6)}`, from, to, type, data, priority, timestamp:new Date().toISOString(), read:false };
  STATE.messageBus.unshift(m);
  if (STATE.messageBus.length > 150) STATE.messageBus = STATE.messageBus.slice(0,150);
  return m;
}
function getMsgs(agent, unread=false) {
  return STATE.messageBus.filter(m => (m.to===agent||m.to==='all') && (!unread||!m.read));
}
function markRead(agent) { STATE.messageBus.forEach(m => { if(m.to===agent||m.to==='all') m.read=true; }); }
function log(agent, action, level='info') {
  const e = { timestamp:new Date().toISOString(), agent, action, level };
  STATE.actionLog.unshift(e);
  if (STATE.actionLog.length > 500) STATE.actionLog = STATE.actionLog.slice(0,500);
  if (STATE.agents[agent]) STATE.agents[agent].lastAction = action;
  console.log(`[${agent.toUpperCase()}] ${action}`);
}
function addAlert(type, message, agent) {
  STATE.alerts.unshift({ id:Date.now(), type, message, agent, timestamp:new Date().toISOString(), resolved:false });
  if (STATE.alerts.length > 50) STATE.alerts = STATE.alerts.slice(0,50);
}
function setAgent(name, status, extra={}) { STATE.agents[name] = { ...STATE.agents[name], status, ...extra }; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function formatBytes(b) { return b>1024*1024 ? (b/1024/1024).toFixed(1)+'Mo' : (b/1024).toFixed(0)+'Ko'; }

// ════════════════════════════════════════════════════════════════
//  AGENT ANALYTICS
// ════════════════════════════════════════════════════════════════
async function runAnalytics() {
  if (!STATE.creds.tiktok || !fetch) return;
  setAgent('analytics','running');
  log('analytics','Récupération stats TikTok');
  try {
    const res = await fetch('https://open.tiktokapis.com/v2/video/list/?fields=id,title,create_time,like_count,comment_count,share_count,view_count', {
      method:'POST', headers:{'Authorization':`Bearer ${STATE.creds.tiktok}`,'Content-Type':'application/json; charset=UTF-8'}, body:JSON.stringify({max_count:20})
    });
    const json = await res.json();
    const videos = json?.data?.videos || [];
    if (videos.length > 0) {
      STATE.analytics.videos = videos;
      STATE.analytics.lastFetched = new Date().toISOString();
      STATE.analytics.avgViews = Math.round(videos.reduce((a,v)=>a+(v.view_count||0),0)/videos.length);
      const avgLikes = videos.reduce((a,v)=>a+(v.like_count||0),0)/videos.length;
      STATE.analytics.engRate = STATE.analytics.avgViews>0 ? parseFloat((avgLikes/STATE.analytics.avgViews*100).toFixed(2)) : 0;
      log('analytics',`avg ${STATE.analytics.avgViews} vues · ${STATE.analytics.engRate}% eng`,'success');
      msg('analytics','all','analytics_report',{avgViews:STATE.analytics.avgViews,engRate:STATE.analytics.engRate},'high');
      if (STATE.analytics.engRate < 3 && videos.length >= 3) {
        msg('analytics','veille','strategy_signal',{signal:'low_engagement',engRate:STATE.analytics.engRate,action:'explore_new_niche'},'high');
      }
    }
    STATE.agents.analytics.cycleCount = (STATE.agents.analytics.cycleCount||0)+1;
    setAgent('analytics','idle',{lastRun:new Date().toISOString()});
  } catch(e) {
    log('analytics','Erreur: '+e.message,'error'); setAgent('analytics','error');
    if (e.message.includes('401')) addAlert('api_limit','Token TikTok expiré','analytics');
  }
}

// ════════════════════════════════════════════════════════════════
//  AGENT VEILLE
// ════════════════════════════════════════════════════════════════
async function runVeille() {
  if (!STATE.creds.anthropic || !fetch) return;
  setAgent('veille','running');
  const signals = getMsgs('veille',true);
  const doRotate = signals.some(m=>m.data?.action==='explore_new_niche');
  markRead('veille');
  log('veille','Analyse stratégie'+(doRotate?' [rotation]':''));
  try {
    const prompt = doRotate
      ? `Expert TikTok France. Niche "${STATE.strategy.niche}" engagement faible. Propose sous-niche similaire plus performante. JSON UNIQUEMENT: {"niche":"...","ton":"Dramatique","raison":"...","hashtags":["h1","h2","h3"],"visualStyle":"cinematique"}`
      : `Expert TikTok France. Optimise stratégie niche "${STATE.strategy.niche}". JSON UNIQUEMENT: {"optimisation":"conseil concret","hashtags":["h1","h2","h3"],"ton":"Dramatique","visualStyle":"cinematique"}`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{'Content-Type':'application/json','x-api-key':STATE.creds.anthropic,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:400,messages:[{role:'user',content:prompt}]})
    });
    const data = await res.json();
    let raw = (data.content||[]).map(b=>b.text||'').join('').trim();
    if (!raw) throw new Error('Réponse vide');
    const s=raw.indexOf('{'), e=raw.lastIndexOf('}');
    if (s===-1||e===-1) throw new Error('Pas de JSON: '+raw.slice(0,80));
    const parsed = JSON.parse(raw.slice(s,e+1));
    if (doRotate && parsed.niche) {
      const old = STATE.strategy.niche;
      Object.assign(STATE.strategy,{niche:parsed.niche,ton:parsed.ton||STATE.strategy.ton,topHashtags:parsed.hashtags||[],visualStyle:parsed.visualStyle||STATE.strategy.visualStyle,lastUpdated:new Date().toISOString()});
      log('veille',`Niche: ${old} → ${parsed.niche}`,'success');
      msg('veille','all','strategy_update',{niche:parsed.niche,ton:parsed.ton,oldNiche:old},'high');
    } else {
      Object.assign(STATE.strategy,{topHashtags:parsed.hashtags||STATE.strategy.topHashtags,ton:parsed.ton||STATE.strategy.ton,lastUpdated:new Date().toISOString()});
      log('veille','Optimisation: '+parsed.optimisation,'success');
      msg('veille','contenu','strategy_update',{niche:STATE.strategy.niche,ton:STATE.strategy.ton},'normal');
    }
    STATE.agents.veille.cycleCount=(STATE.agents.veille.cycleCount||0)+1;
    setAgent('veille','idle',{lastRun:new Date().toISOString()});
  } catch(e) {
    log('veille','Erreur: '+e.message,'error'); setAgent('veille','error');
  }
}

// ════════════════════════════════════════════════════════════════
//  AGENT CONTENU
// ════════════════════════════════════════════════════════════════
async function runContenu() {
  if (!STATE.creds.anthropic || !fetch) return;
  if (STATE.scripts.filter(s=>['ready','audio_pending','audio_ready'].includes(s.status)).length >= 3) {
    log('contenu','Scripts suffisants — cycle ignoré'); return;
  }
  setAgent('contenu','running');
  const signals = getMsgs('contenu',true);
  const stratSig = signals.find(m=>m.type==='strategy_update');
  markRead('contenu');
  if (stratSig) { STATE.strategy.niche=stratSig.data.niche||STATE.strategy.niche; STATE.strategy.ton=stratSig.data.ton||STATE.strategy.ton; }
  const existing = STATE.scripts.map(s=>s.titre).slice(-10).join(', ')||'aucun';
  const prompt = `Génère 2 scripts TikTok. Niche: "${STATE.strategy.niche}". Ton: "${STATE.strategy.ton}". Durée: 60s max (150 mots). Éviter: ${existing}. JSON UNIQUEMENT sans backticks: {"scripts":[{"titre":"...","accroche":"...","corps":"...","cta":"...","hashtags":["h1","h2","h3","h4","h5"],"note_viralite":85,"conseil_visuel":"image description in english for AI generation","sujet":"one sentence summary"}]}`;
  log('contenu',`Génération scripts — ${STATE.strategy.niche}`);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{'Content-Type':'application/json','x-api-key':STATE.creds.anthropic,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:3000,messages:[{role:'user',content:prompt}]})
    });
    const data = await res.json();
    let raw=(data.content||[]).map(b=>b.text||'').join('').trim();
    if (!raw) throw new Error('Réponse vide');
    const s=raw.indexOf('{'),e=raw.lastIndexOf('}');
    if(s===-1||e===-1) throw new Error('Pas de JSON');
    const parsed=JSON.parse(raw.slice(s,e+1));
    parsed.scripts.forEach(sc=>{
      STATE.scripts.push({...sc,id:`${Date.now()}_${Math.random().toString(36).slice(2,5)}`,status:'ready',niche:STATE.strategy.niche,visualStyle:STATE.strategy.visualStyle,createdAt:new Date().toISOString()});
    });
    log('contenu',`${parsed.scripts.length} scripts générés`,'success');
    msg('contenu','voix','scripts_ready',{count:parsed.scripts.length,titres:parsed.scripts.map(s=>s.titre)},'high');
    STATE.agents.contenu.cycleCount=(STATE.agents.contenu.cycleCount||0)+1;
    setAgent('contenu','idle',{lastRun:new Date().toISOString()});
  } catch(e) {
    log('contenu','Erreur: '+e.message,'error'); setAgent('contenu','error');
    if(e.message.includes('429')) addAlert('api_limit','Quota Anthropic atteint','contenu');
  }
}

// ════════════════════════════════════════════════════════════════
//  AGENT VOIX (ElevenLabs)
// ════════════════════════════════════════════════════════════════
async function runVoix() {
  if (!STATE.creds.elevenlabs || !fetch) {
    if (!STATE.creds.elevenlabs) addAlert('payment','Clé ElevenLabs manquante','voix');
    return;
  }
  const scriptsReady = STATE.scripts.filter(s=>s.status==='ready');
  if (!scriptsReady.length) { log('voix','Aucun script prêt'); return; }
  setAgent('voix','running');
  for (const script of scriptsReady.slice(0,2)) {
    log('voix',`Voix-off: "${script.titre}"`);
    script.status = 'audio_pending';
    const texte = [script.accroche,script.corps,script.cta].filter(Boolean).join(' ');
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${STATE.creds.voiceId}`, {
        method:'POST',
        headers:{'xi-api-key':STATE.creds.elevenlabs,'Content-Type':'application/json','Accept':'audio/mpeg'},
        body:JSON.stringify({text:texte,model_id:'eleven_multilingual_v2',voice_settings:{stability:0.5,similarity_boost:0.75,style:0.5,use_speaker_boost:true}})
      });
      if (!res.ok) {
        const err=await res.json().catch(()=>({}));
        if(res.status===401||res.status===403) { addAlert('payment','Clé ElevenLabs invalide ou quota dépassé','voix'); script.status='ready'; break; }
        throw new Error(`ElevenLabs ${res.status}: ${JSON.stringify(err)}`);
      }
      const buf = await res.buffer();
      const slug = script.titre.replace(/[^a-z0-9]/gi,'_').slice(0,28).toLowerCase();
      const fname = `voixoff_${Date.now()}_${slug}.mp3`;
      const fpath = path.join('/tmp/audio',fname);
      fs.writeFileSync(fpath,buf);
      STATE.audioFiles.push({scriptId:script.id,filename:fname,path:fpath,size:buf.length});
      script.status='audio_ready'; script.audioFile=fname;
      log('voix',`✅ ${fname} (${formatBytes(buf.length)})`,'success');
      msg('voix','montage','audio_ready',{scriptId:script.id,titre:script.titre,audioFile:fname},'high');
      await sleep(1000);
    } catch(e) {
      script.status='ready';
      log('voix','Erreur: '+e.message,'error');
      if(e.message.includes('429')||e.message.includes('quota')) { addAlert('payment','Quota ElevenLabs dépassé','voix'); break; }
    }
  }
  STATE.agents.voix.cycleCount=(STATE.agents.voix.cycleCount||0)+1;
  setAgent('voix','idle',{lastRun:new Date().toISOString()});
}

// ════════════════════════════════════════════════════════════════
//  AGENT MONTAGE (FFmpeg optionnel)
// ════════════════════════════════════════════════════════════════
function sanitizeText(t) {
  return (t||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9 .,!?]/g,' ').replace(/\s+/g,' ').trim().slice(0,80);
}
function couperLignes(t,n=26){
  const mots=t.split(' ').filter(Boolean); const L=[]; let l='';
  mots.forEach(m=>{ if((l+(l?' ':'')+m).length>n){if(l)L.push(l);l=m.slice(0,n);}else{l=(l?l+' ':'')+m;} });
  if(l)L.push(l); return L.slice(0,3).join('\n');
}
function getAudioDuration(p) {
  return new Promise(resolve=>{
    if(!ffmpeg){try{const s=fs.statSync(p).size;resolve(Math.max(15,Math.min(120,(s*8)/(128*1000))));}catch(e){resolve(60);}return;}
    ffmpeg.ffprobe(p,(err,meta)=>{
      if(!err&&meta?.format?.duration){resolve(meta.format.duration);}
      else{try{const s=fs.statSync(p).size;resolve(Math.max(15,Math.min(120,(s*8)/(128*1000))));}catch(e2){resolve(60);}}
    });
  });
}
async function downloadImage(prompt,outPath){
  if(!fetch) return null;
  const enc=encodeURIComponent((prompt||'cinematic scene').slice(0,200));
  const seed=Math.floor(Math.random()*99999);
  const url=`https://image.pollinations.ai/prompt/${enc}?width=1080&height=1920&seed=${seed}&nologo=true`;
  for(let i=0;i<2;i++){
    try{
      const r=await fetch(url,{timeout:20000});
      if(r.ok){const b=await r.buffer();fs.writeFileSync(outPath,b);return outPath;}
    }catch(e){await sleep(2000);}
  }
  return null;
}
function creerSegment(imgPath,dur,texte,outPath,couleur){
  return new Promise((resolve,reject)=>{
    if(!ffmpeg){reject(new Error('FFmpeg non disponible'));return;}
    const txt=sanitizeText(texte); const ml=couperLignes(txt);
    const filters=['scale=1080:1920:force_original_aspect_ratio=increase','crop=1080:1920'];
    if(ml.trim()) filters.push(`drawtext=text='${ml}':fontsize=52:fontcolor=${couleur||'white'}:borderw=4:bordercolor=black@0.8:x=(w-text_w)/2:y=h-320:line_spacing=10`);
    ffmpeg(imgPath).inputOptions(['-loop 1',`-t ${dur}`]).videoFilters(filters)
      .outputOptions(['-c:v libx264','-preset ultrafast','-pix_fmt yuv420p',`-t ${dur}`,'-r 30'])
      .output(outPath).on('end',resolve)
      .on('error',err=>{
        ffmpeg(imgPath).inputOptions(['-loop 1',`-t ${dur}`]).videoFilters(['scale=1080:1920:force_original_aspect_ratio=increase','crop=1080:1920'])
          .outputOptions(['-c:v libx264','-preset ultrafast','-pix_fmt yuv420p',`-t ${dur}`,'-r 30'])
          .output(outPath).on('end',resolve).on('error',reject).run();
      }).run();
  });
}
function assembler(segs,audio,out){
  return new Promise((resolve,reject)=>{
    if(!ffmpeg){reject(new Error('FFmpeg non disponible'));return;}
    const lst=out.replace('.mp4','_list.txt');
    fs.writeFileSync(lst,segs.map(p=>`file '${p}'`).join('\n'));
    ffmpeg().input(lst).inputOptions(['-f concat','-safe 0']).input(audio)
      .outputOptions(['-c:v copy','-c:a aac','-shortest','-movflags +faststart'])
      .output(out).on('end',()=>{try{fs.unlinkSync(lst);}catch(e){}resolve()}).on('error',reject).run();
  });
}
function prochainCreneau(){
  const now=new Date(); const hours=STATE.strategy.bestHours||[8,19,21];
  for(let d=0;d<=3;d++){
    for(const h of hours){
      const c=new Date(now); c.setDate(c.getDate()+d); c.setHours(h,0,0,0);
      if(c>now){
        const busy=Object.values(STATE.publishQueue).some(v=>v.scheduledAt&&v.status!=='published'&&Math.abs(new Date(v.scheduledAt)-c)<3600000);
        if(!busy)return c;
      }
    }
  }
  return new Date(Date.now()+2*3600000);
}
async function runMontage(){
  if(!ffmpeg){log('montage','FFmpeg non disponible sur ce serveur — Agent Montage désactivé','warn');return;}
  const ready=STATE.scripts.filter(s=>s.status==='audio_ready'&&s.audioFile);
  if(!ready.length){log('montage','Aucun audio prêt');return;}
  setAgent('montage','running');
  for(const script of ready.slice(0,1)){
    log('montage',`Montage: "${script.titre}"`);
    script.status='video_pending';
    const ap=path.join('/tmp/audio',script.audioFile);
    if(!fs.existsSync(ap)){script.status='audio_ready';continue;}
    try{
      const dur=await getAudioDuration(ap);
      log('montage',`Durée: ${Math.round(dur)}s`);
      const texte=[script.accroche,script.corps,script.cta].filter(Boolean).join(' ');
      const mots=texte.split(/\s+/).filter(Boolean);
      const nbSeg=Math.max(1,Math.ceil(dur/5));
      const mPS=Math.ceil(mots.length/nbSeg);
      const segments=[];
      for(let i=0;i<nbSeg;i++){
        const sm=mots.slice(i*mPS,(i+1)*mPS);
        segments.push({texte:sm.join(' '),prompt:(i===0?script.conseil_visuel||script.sujet:sm.slice(0,4).join(' '))||script.titre,duration:i<nbSeg-1?5:Math.max(3,dur-(nbSeg-1)*5)});
      }
      const style=script.visualStyle||STATE.strategy.visualStyle||'cinematique';
      const couleur=style==='dynamique'?'yellow':'white';
      log('montage',`Génération ${segments.length} images IA...`);
      const imgPaths=new Array(segments.length).fill(null);
      for(let b=0;b<segments.length;b+=3){
        const end=Math.min(b+3,segments.length);
        await Promise.all(segments.slice(b,end).map(async(seg,j)=>{
          const ip=path.join('/tmp/images',`${script.id}_${b+j}.jpg`);
          const ok=await downloadImage(seg.prompt,ip);
          if(ok){imgPaths[b+j]=ip;log('montage',`Image ${b+j+1}/${segments.length} OK`);}
          else{
            // Fallback: image noire
            try{ffmpeg&&await new Promise((res,rej)=>ffmpeg().input('color=c=black:size=1080x1920:rate=1').inputOptions(['-f lavfi']).outputOptions(['-t 1','-frames:v 1']).output(ip).on('end',res).on('error',rej).run());}catch(e){}
            if(!fs.existsSync(ip)||fs.statSync(ip).size<100){fs.writeFileSync(ip,Buffer.alloc(100));}
            imgPaths[b+j]=ip;
            log('montage',`Image ${b+j+1} → fallback`,'warn');
          }
        }));
        await sleep(500);
      }
      log('montage',`Encodage ${segments.length} segments...`);
      const segPaths=[];
      for(let i=0;i<segments.length;i++){
        const sp=path.join('/tmp/segments',`${script.id}_${i}.mp4`);
        await creerSegment(imgPaths[i],segments[i].duration,segments[i].texte,sp,couleur);
        segPaths.push(sp);
      }
      log('montage','Assemblage final...');
      const slug=script.titre.replace(/[^a-z0-9]/gi,'_').slice(0,28).toLowerCase();
      const outFile=`tiktok_${Date.now()}_${slug}.mp4`;
      const outPath=path.join('/tmp/videos',outFile);
      await assembler(segPaths,ap,outPath);
      const stat=fs.statSync(outPath);
      [...imgPaths,...segPaths].forEach(p=>{try{if(p)fs.unlinkSync(p);}catch(e){}});
      STATE.videoFiles.push({scriptId:script.id,filename:outFile,path:outPath,size:stat.size,createdAt:new Date().toISOString()});
      script.status='video_ready'; script.videoFile=outFile;
      const scheduledAt=prochainCreneau();
      STATE.publishQueue[outFile]={titre:script.titre,caption:[script.accroche,script.corps,script.cta].filter(Boolean).join(' ').slice(0,300),hashtags:script.hashtags||[],filePath:outPath,fileSize:stat.size,scheduledAt,status:'pending_approval',addedAt:new Date().toISOString(),error:null,autoApproveAt:new Date(Date.now()+2*3600000).toISOString()};
      setTimeout(()=>{const v=STATE.publishQueue[outFile];if(v&&v.status==='pending_approval'){v.status='scheduled';log('montage',`Auto-approuvé: "${v.titre}"`,'info');}},2*3600000);
      log('montage',`✅ ${outFile} (${formatBytes(stat.size)})`,'success');
      msg('montage','pub','video_ready',{titre:script.titre,videoFile:outFile,scheduledAt},'high');
    }catch(e){
      script.status='audio_ready';
      log('montage','Erreur: '+e.message,'error');
    }
  }
  STATE.agents.montage.cycleCount=(STATE.agents.montage.cycleCount||0)+1;
  setAgent('montage','idle',{lastRun:new Date().toISOString()});
}

// ════════════════════════════════════════════════════════════════
//  AGENT PUBLICATION
// ════════════════════════════════════════════════════════════════
function runPub(){
  const signals=getMsgs('pub',true);markRead('pub');
  const sc=signals.find(m=>m.type==='schedule_update');
  if(sc?.data?.bestHours){STATE.strategy.bestHours=sc.data.bestHours;log('pub','Horaires mis à jour','success');}
  const n=Object.values(STATE.publishQueue).filter(v=>v.status==='scheduled').length;
  log('pub',`${n} vidéo(s) planifiée(s)`);
  Object.entries(STATE.publishQueue).forEach(([fn,v])=>{if(v.status==='scheduled'&&v.scheduledAt&&new Date(v.scheduledAt)<=new Date())publierVideo(fn);});
  STATE.agents.pub.cycleCount=(STATE.agents.pub.cycleCount||0)+1;
  setAgent('pub','idle',{lastRun:new Date().toISOString()});
}
async function publierVideo(filename){
  const v=STATE.publishQueue[filename];
  if(!v||!STATE.creds.tiktok||!fetch)return;
  v.status='uploading';setAgent('pub','running');
  log('pub',`Upload: "${v.titre}"`);
  try{
    if(!fs.existsSync(v.filePath))throw new Error('Fichier introuvable: '+v.filePath);
    const buf=fs.readFileSync(v.filePath);const size=buf.length;
    const cap=((v.caption||v.titre||'').slice(0,150)+'\n\n'+(v.hashtags||[]).map(h=>'#'+h.replace('#','')).join(' ')).trim();
    const init=await fetch('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/',{method:'POST',headers:{'Authorization':`Bearer ${STATE.creds.tiktok}`,'Content-Type':'application/json; charset=UTF-8'},body:JSON.stringify({post_info:{title:cap.slice(0,150),privacy_level:'SELF_ONLY',disable_duet:false,disable_comment:false,disable_stitch:false},source_info:{source:'FILE_UPLOAD',video_size:size,chunk_size:size,total_chunk_count:1}})});
    const id=await init.json();
    if(!id?.data?.publish_id)throw new Error('Init échoué');
    v.tiktokPublishId=id.data.publish_id;
    await fetch(id.data.upload_url,{method:'PUT',headers:{'Content-Type':'video/mp4','Content-Range':`bytes 0-${size-1}/${size}`,'Content-Length':String(size)},body:buf});
    for(let i=0;i<12;i++){
      await sleep(5000);
      const st=await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/',{method:'POST',headers:{'Authorization':`Bearer ${STATE.creds.tiktok}`,'Content-Type':'application/json; charset=UTF-8'},body:JSON.stringify({publish_id:id.data.publish_id})});
      const sd=await st.json();const status=sd?.data?.status;
      if(status==='PUBLISH_COMPLETE'||status==='SEND_TO_USER_INBOX'){v.status='published';v.publishedAt=new Date().toISOString();log('pub',`✅ Publié: "${v.titre}"`,'success');msg('pub','analytics','video_published',{titre:v.titre},'high');try{fs.unlinkSync(v.filePath);}catch(e){}break;}
      if(status==='FAILED')throw new Error('TikTok a refusé la vidéo');
    }
  }catch(e){
    v.status='error';v.error=e.message;log('pub','Erreur: '+e.message,'error');
    if(e.message.includes('401'))addAlert('api_limit','Token TikTok expiré','pub');
  }
  setAgent('pub','idle',{lastRun:new Date().toISOString()});
}

// ════════════════════════════════════════════════════════════════
//  ORCHESTRATEUR
// ════════════════════════════════════════════════════════════════
async function runOrchestrator(){
  log('orchestrateur','═══ CYCLE ═══');
  await runAnalytics(); await sleep(2000);
  await runVeille();    await sleep(2000);
  await runContenu();   await sleep(2000);
  await runVoix();      await sleep(2000);
  await runMontage();   await sleep(1000);
  runPub();
  log('orchestrateur','═══ TERMINÉ ═══','success');
}
if(cron){
  cron.schedule('0 * * * *', runOrchestrator);
  cron.schedule('*/5 * * * *', ()=>Object.entries(STATE.publishQueue).forEach(([fn,v])=>{if(v.status==='scheduled'&&v.scheduledAt&&new Date(v.scheduledAt)<=new Date())publierVideo(fn);}));
}

// ════════════════════════════════════════════════════════════════
//  ROUTES API
// ════════════════════════════════════════════════════════════════
app.get('/', (req,res) => res.json({status:'ok',message:'TikTok Agent Suite v3',version:'3.0.0',ffmpeg:!!ffmpeg,cron:!!cron}));

app.get('/dashboard',(req,res)=>res.json({
  agents:STATE.agents,strategy:STATE.strategy,
  analytics:{...STATE.analytics,videos:STATE.analytics.videos.slice(0,5)},
  alerts:STATE.alerts.filter(a=>!a.resolved),
  scripts:STATE.scripts.slice(0,15).map(s=>({id:s.id,titre:s.titre,status:s.status,niche:s.niche,createdAt:s.createdAt})),
  audioFiles:STATE.audioFiles.slice(0,10).map(a=>({scriptId:a.scriptId,filename:a.filename,size:a.size})),
  videoFiles:STATE.videoFiles.slice(0,10).map(v=>({scriptId:v.scriptId,filename:v.filename,size:v.size,createdAt:v.createdAt})),
  publishQueue:Object.fromEntries(Object.entries(STATE.publishQueue).map(([k,v])=>[k,{titre:v.titre,status:v.status,scheduledAt:v.scheduledAt,publishedAt:v.publishedAt,error:v.error,autoApproveAt:v.autoApproveAt}])),
  messageBus:STATE.messageBus.slice(0,30),
  actionLog:STATE.actionLog.slice(0,50),
  credentials:{tiktok:!!STATE.creds.tiktok,anthropic:!!STATE.creds.anthropic,elevenlabs:!!STATE.creds.elevenlabs},
}));

app.post('/configure',(req,res)=>{
  const{token,anthropic_key,elevenlabs_key,voice_id,niche,ton}=req.body;
  if(token){STATE.creds.tiktok=token;log('system','Token TikTok configuré','success');}
  if(anthropic_key){STATE.creds.anthropic=anthropic_key;log('system','Clé Anthropic configurée','success');}
  if(elevenlabs_key){STATE.creds.elevenlabs=elevenlabs_key;log('system','Clé ElevenLabs configurée','success');}
  if(voice_id)STATE.creds.voiceId=voice_id;
  if(niche)STATE.strategy.niche=niche;
  if(ton)STATE.strategy.ton=ton;
  res.json({ok:true,credentials:{tiktok:!!STATE.creds.tiktok,anthropic:!!STATE.creds.anthropic,elevenlabs:!!STATE.creds.elevenlabs}});
});

app.get('/progress',(req,res)=>{
  const steps=[
    {agent:'analytics',label:'Analyse TikTok',done:(STATE.agents.analytics?.cycleCount||0)>0},
    {agent:'veille',label:'Stratégie niche',done:(STATE.agents.veille?.cycleCount||0)>0},
    {agent:'contenu',label:'Génération scripts',done:STATE.scripts.length>0},
    {agent:'voix',label:'Voix-off',done:STATE.audioFiles.length>0},
    {agent:'montage',label:'Montage vidéo',done:STATE.videoFiles.length>0},
    {agent:'pub',label:'Publication',done:Object.values(STATE.publishQueue).some(v=>v.status==='published')},
  ];
  const current=Object.entries(STATE.agents).find(([,a])=>a.status==='running')?.[0]||null;
  const done=steps.filter(s=>s.done).length;
  res.json({steps,currentAgent:current,doneCount:done,total:steps.length,pct:Math.round(done/steps.length*100)});
});

app.post('/video/:f/approve',(req,res)=>{
  const v=STATE.publishQueue[req.params.f];
  if(!v)return res.status(404).json({error:'Vidéo introuvable'});
  v.status='scheduled';v.approvedAt=new Date().toISOString();
  log('system',`✅ Approuvé: "${v.titre}"`,'success');
  res.json({ok:true,scheduledAt:v.scheduledAt});
});
app.post('/video/:f/reject',async(req,res)=>{
  const v=STATE.publishQueue[req.params.f];
  if(!v)return res.status(404).json({error:'Vidéo introuvable'});
  const titre=v.titre;
  try{if(fs.existsSync(v.filePath))fs.unlinkSync(v.filePath);}catch(e){}
  delete STATE.publishQueue[req.params.f];
  STATE.videoFiles=STATE.videoFiles.filter(vf=>vf.filename!==req.params.f);
  const sc=STATE.scripts.find(s=>s.titre===titre);
  if(sc)sc.status='rejected';
  log('system',`❌ Rejeté: "${titre}" — régénération`,'warn');
  msg('system','contenu','content_rejected',{titre},'high');
  res.json({ok:true});
  setTimeout(async()=>{STATE.scripts=STATE.scripts.filter(s=>s.status!=='rejected');await runContenu();},3000);
});

app.get('/video/:filename',(req,res)=>{
  const fp=path.join('/tmp/videos',req.params.filename.replace(/\.\./g,''));
  if(!fs.existsSync(fp))return res.status(404).json({error:'Introuvable'});
  const stat=fs.statSync(fp);const size=stat.size;const range=req.headers.range;
  if(range){
    const[start,end]=[...range.replace(/bytes=/,'').split('-')].map((v,i)=>v?parseInt(v):i===1?size-1:0);
    const chunk=end-start+1;
    res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${size}`,'Accept-Ranges':'bytes','Content-Length':chunk,'Content-Type':'video/mp4'});
    fs.createReadStream(fp,{start,end}).pipe(res);
  }else{
    res.writeHead(200,{'Content-Length':size,'Content-Type':'video/mp4','Accept-Ranges':'bytes'});
    fs.createReadStream(fp).pipe(res);
  }
});

app.get('/videos/list',(req,res)=>{
  try{
    const dir='/tmp/videos';
    if(!fs.existsSync(dir))return res.json({videos:[]});
    const files=fs.readdirSync(dir).filter(f=>f.endsWith('.mp4')||f.endsWith('.webm')).map(f=>{
      const fp=path.join(dir,f);const st=fs.statSync(fp);
      const pq=STATE.publishQueue[f];const sc=STATE.scripts.find(s=>s.videoFile===f);
      return{filename:f,size:st.size,createdAt:st.birthtime,titre:sc?.titre||pq?.titre||f,status:pq?.status||'ready',scheduledAt:pq?.scheduledAt||null,autoApproveAt:pq?.autoApproveAt||null,url:`/video/${f}`};
    }).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
    res.json({videos:files});
  }catch(e){res.json({videos:[]});}
});

const upload2=multer?multer({dest:'/tmp/uploads/',limits:{fileSize:200*1024*1024}}):null;
if(upload2){
  app.post('/schedule',upload2.single('video'),(req,res)=>{
    if(!req.file)return res.status(400).json({error:'Fichier requis'});
    const{titre,caption,hashtags,scheduled_at}=req.body;
    const fn=req.file.originalname||req.file.filename;
    const sa=scheduled_at?new Date(scheduled_at):prochainCreneau();
    STATE.publishQueue[fn]={titre,caption,filePath:req.file.path,fileSize:req.file.size,hashtags:hashtags?JSON.parse(hashtags):[],scheduledAt:sa,status:'scheduled',addedAt:new Date().toISOString(),error:null};
    if(sa>new Date()){const d=sa.getTime()-Date.now();setTimeout(()=>publierVideo(fn),d);}
    else setImmediate(()=>publierVideo(fn));
    res.json({ok:true,filename:fn,scheduledAt:sa});
  });
}

app.get('/status',(req,res)=>res.json({ok:true,queue:STATE.publishQueue,token_set:!!STATE.creds.tiktok}));
app.get('/messages',(req,res)=>res.json({messages:STATE.messageBus.slice(0,50)}));
app.get('/logs',(req,res)=>res.json({logs:STATE.actionLog.slice(0,100)}));
app.get('/alerts',(req,res)=>res.json({alerts:STATE.alerts}));
app.post('/alerts/:id/resolve',(req,res)=>{const a=STATE.alerts.find(a=>a.id===parseInt(req.params.id));if(a)a.resolved=true;res.json({ok:true});});
app.get('/scripts',(req,res)=>res.json({scripts:STATE.scripts}));
app.get('/strategy',(req,res)=>res.json({strategy:STATE.strategy}));
app.post('/strategy',(req,res)=>{Object.assign(STATE.strategy,req.body);STATE.strategy.lastUpdated=new Date().toISOString();log('system','Stratégie mise à jour');res.json({ok:true,strategy:STATE.strategy});});
app.post('/run/:agent',async(req,res)=>{
  const{agent}=req.params;res.json({ok:true,message:`Agent ${agent} démarré`});
  if(agent==='analytics')await runAnalytics();
  else if(agent==='veille')await runVeille();
  else if(agent==='contenu')await runContenu();
  else if(agent==='voix')await runVoix();
  else if(agent==='montage')await runMontage();
  else if(agent==='pub')runPub();
  else if(agent==='all')await runOrchestrator();
});

app.listen(PORT,()=>{
  console.log(`\n🤖 TikTok Agent Suite v3 — port ${PORT}`);
  console.log(`   FFmpeg: ${ffmpeg?'✅':'❌ non disponible'}`);
  console.log(`   Cron:   ${cron?'✅':'❌ non disponible'}`);
  log('system','Serveur démarré','success');
  setTimeout(runOrchestrator,60000);
});
