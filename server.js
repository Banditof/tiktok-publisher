// ════════════════════════════════════════════════════════════════
//  ORCHESTRATEUR D'AGENTS IA AUTONOMES — TIKTOK ROBOT SUITE v2
//  Déployé sur Railway — tourne 24h/24 sans intervention humaine
// ════════════════════════════════════════════════════════════════
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const fetch   = require('node-fetch');
const fs      = require('fs');
const cron    = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit:'10mb' }));
const upload = multer({ dest:'/tmp/videos/', limits:{ fileSize:200*1024*1024 } });

// ════════════════════════════════════════════════════════════════
//  ÉTAT GLOBAL
// ════════════════════════════════════════════════════════════════
const state = {
  tiktokToken:'', anthropicKey:'', elevenLabsKey:'', pexelsKey:'',
  strategy:{ niche:'Storytelling', ton:'Dramatique', postingFrequency:1, bestHours:[8,19,21], topHashtags:[], lastUpdated:null },
  publishQueue:{}, analytics:{ videos:[], lastFetched:null, avgViews:0, engRate:0, topPerformer:null },
  agents:{ veille:{status:'idle',lastRun:null,cycleCount:0}, contenu:{status:'idle',lastRun:null,cycleCount:0}, pub:{status:'idle',lastRun:null,cycleCount:0}, analytics:{status:'idle',lastRun:null,cycleCount:0} },
  messageBus:[], alerts:[], actionLog:[], scripts:[],
};

// ════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════
function sendMessage(from,to,type,data,priority='normal'){
  const msg={id:Date.now()+'_'+Math.random().toString(36).slice(2,6),from,to,type,data,priority,timestamp:new Date().toISOString(),read:false};
  state.messageBus.unshift(msg);
  if(state.messageBus.length>100) state.messageBus=state.messageBus.slice(0,100);
  logAction(from,'MESSAGE → '+to+' ['+type+']','info');
  return msg;
}
function getMessages(agent,unreadOnly=false){
  return state.messageBus.filter(m=>(m.to===agent||m.to==='all')&&(!unreadOnly||!m.read));
}
function markRead(agent){ state.messageBus.forEach(m=>{if(m.to===agent||m.to==='all')m.read=true;}); }
function logAction(agent,action,level='info',details=null){
  const e={timestamp:new Date().toISOString(),agent,action,level,details};
  state.actionLog.unshift(e);
  if(state.actionLog.length>500) state.actionLog=state.actionLog.slice(0,500);
  console.log('['+agent.toUpperCase()+'] '+action);
}
function addAlert(type,message,agentSource){
  state.alerts.unshift({id:Date.now(),type,message,agent:agentSource,timestamp:new Date().toISOString(),resolved:false});
  if(state.alerts.length>50) state.alerts=state.alerts.slice(0,50);
}
function setAgent(name,status,extra={}){ state.agents[name]={...state.agents[name],status,...extra}; }
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

// ════════════════════════════════════════════════════════════════
//  AGENT ANALYTICS
// ════════════════════════════════════════════════════════════════
async function runAnalytics(){
  if(!state.tiktokToken) return;
  setAgent('analytics','running');
  logAction('analytics','Cycle analytics démarré');
  try{
    const res=await fetch('https://open.tiktokapis.com/v2/video/list/?fields=id,title,create_time,like_count,comment_count,share_count,view_count',{
      method:'POST', headers:{'Authorization':'Bearer '+state.tiktokToken,'Content-Type':'application/json; charset=UTF-8'},
      body:JSON.stringify({max_count:20})
    });
    const json=await res.json();
    const videos=json?.data?.videos||[];
    if(videos.length>0){
      state.analytics.videos=videos;
      state.analytics.lastFetched=new Date().toISOString();
      state.analytics.avgViews=Math.round(videos.reduce((a,v)=>a+(v.view_count||0),0)/videos.length);
      state.analytics.engRate=state.analytics.avgViews>0?parseFloat(((videos.reduce((a,v)=>a+(v.like_count||0),0)/videos.length)/state.analytics.avgViews*100).toFixed(2)):0;
      state.analytics.topPerformer=videos.reduce((a,b)=>(a.view_count||0)>(b.view_count||0)?a:b,videos[0]);
      logAction('analytics','avg '+state.analytics.avgViews+' vues, eng '+state.analytics.engRate+'%','success');
      sendMessage('analytics','all','analytics_report',{avgViews:state.analytics.avgViews,engRate:state.analytics.engRate,topVideo:state.analytics.topPerformer?.title,videosCount:videos.length},'high');
      if(state.analytics.engRate<3&&videos.length>=3){
        sendMessage('analytics','veille','strategy_signal',{signal:'low_engagement',engRate:state.analytics.engRate,action:'explore_new_niche'},'high');
        logAction('analytics','Signal faible engagement envoyé à Veille','warn');
      }
      if(videos.length>=5){
        const top=([...videos].sort((a,b)=>(b.view_count||0)-(a.view_count||0))).slice(0,3).map(v=>v.title);
        sendMessage('analytics','contenu','content_signal',{signal:'top_performers',topTitles:top},'normal');
      }
    }
    state.agents.analytics.cycleCount=(state.agents.analytics.cycleCount||0)+1;
    setAgent('analytics','idle',{lastRun:new Date().toISOString()});
  }catch(e){
    logAction('analytics','Erreur: '+e.message,'error');
    setAgent('analytics','error');
    if(e.message.includes('401')) addAlert('api_limit','Token TikTok expiré — reconnexion requise','analytics');
  }
}

// ════════════════════════════════════════════════════════════════
//  AGENT VEILLE
// ════════════════════════════════════════════════════════════════
async function runVeille(){
  if(!state.anthropicKey) return;
  setAgent('veille','running');
  const signals=getMessages('veille',true);
  const doRotation=signals.some(m=>m.data?.action==='explore_new_niche');
  markRead('veille');
  logAction('veille','Analyse stratégie'+(doRotation?' [rotation niche]':''));
  try{
    const prompt=doRotation
      ?`Niche TikTok "${state.strategy.niche}" a engagement faible (${state.analytics.engRate}%). Suggère sous-niche plus performante. JSON: {"niche":"...","ton":"...","raison":"...","hashtags":["h1","h2","h3"]}`
      :`Optimise la stratégie pour la niche TikTok "${state.strategy.niche}". JSON: {"optimisation":"conseil court","hashtags":["h1","h2","h3"],"ton":"ton optimal"}`;
    const res=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST', headers:{'Content-Type':'application/json','x-api-key':state.anthropicKey,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:400,messages:[{role:'user',content:prompt}]})
    });
    const data=await res.json();
    let raw=(data.content||[]).map(b=>b.text||'').join('');
    const s=raw.indexOf('{'),e=raw.lastIndexOf('}');
    if(s!==-1&&e!==-1) raw=raw.slice(s,e+1);
    const parsed=JSON.parse(raw);
    if(doRotation&&parsed.niche){
      const old=state.strategy.niche;
      state.strategy.niche=parsed.niche; state.strategy.ton=parsed.ton||state.strategy.ton;
      state.strategy.topHashtags=parsed.hashtags||[]; state.strategy.lastUpdated=new Date().toISOString();
      logAction('veille','Niche: '+old+' → '+parsed.niche,'success');
      sendMessage('veille','all','strategy_update',{niche:parsed.niche,ton:parsed.ton,hashtags:parsed.hashtags,reason:parsed.raison,oldNiche:old},'high');
    } else if(parsed.optimisation){
      state.strategy.topHashtags=parsed.hashtags||state.strategy.topHashtags;
      state.strategy.ton=parsed.ton||state.strategy.ton; state.strategy.lastUpdated=new Date().toISOString();
      logAction('veille','Optimisation: '+parsed.optimisation,'success');
      sendMessage('veille','contenu','strategy_update',{niche:state.strategy.niche,ton:state.strategy.ton,hashtags:parsed.hashtags,optimisation:parsed.optimisation},'normal');
    }
    state.agents.veille.cycleCount=(state.agents.veille.cycleCount||0)+1;
    setAgent('veille','idle',{lastRun:new Date().toISOString()});
  }catch(e){
    logAction('veille','Erreur: '+e.message,'error');
    setAgent('veille','error');
  }
}

// ════════════════════════════════════════════════════════════════
//  AGENT CONTENU
// ════════════════════════════════════════════════════════════════
async function runContenu(){
  if(!state.anthropicKey) return;
  if(state.scripts.filter(s=>s.status==='ready').length>=3){ logAction('contenu','Scripts suffisants — cycle ignoré'); return; }
  setAgent('contenu','running');
  const signals=getMessages('contenu',true);
  const topTitles=signals.find(m=>m.type==='content_signal')?.data?.topTitles||[];
  const stratSig=signals.find(m=>m.type==='strategy_update');
  markRead('contenu');
  if(stratSig){ state.strategy.niche=stratSig.data.niche||state.strategy.niche; state.strategy.ton=stratSig.data.ton||state.strategy.ton; }
  const existing=state.scripts.map(s=>s.titre).join(', ');
  const topCtx=topTitles.length>0?'\nFormats performants: '+topTitles.join(', )+'. S\'inspirer sans copier.':'';
  const prompt='Génère 2 scripts TikTok niche "'+state.strategy.niche+'", ton "'+state.strategy.ton+'", 60s.'+topCtx+'\nÉviter: '+( existing||'aucun')+'.\nJSON sans backticks: {"scripts":[{"titre":"...","accroche":"...","corps":"...","cta":"...","hashtags":["h1","h2","h3","h4","h5"],"note_viralite":85,"conseil_visuel":"description des visuels pour générer des images IA cohérentes avec l\'histoire","sujet":"résumé 1 phrase"}]}';
  logAction('contenu','Génération scripts — niche: '+state.strategy.niche);
  try{
    const res=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST', headers:{'Content-Type':'application/json','x-api-key':state.anthropicKey,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:3000,messages:[{role:'user',content:prompt}]})
    });
    const data=await res.json();
    let raw=(data.content||[]).map(b=>b.text||'').join('');
    const s=raw.indexOf('{'),e=raw.lastIndexOf('}');
    if(s!==-1&&e!==-1) raw=raw.slice(s,e+1);
    const parsed=JSON.parse(raw);
    parsed.scripts.forEach(sc=>{
      state.scripts.push({...sc,id:Date.now()+'_'+Math.random().toString(36).slice(2,5),status:'ready',niche:state.strategy.niche,createdAt:new Date().toISOString()});
    });
    logAction('contenu',parsed.scripts.length+' scripts générés','success');
    sendMessage('contenu','all','scripts_ready',{count:parsed.scripts.length,titres:parsed.scripts.map(s=>s.titre),niche:state.strategy.niche},'normal');
    state.agents.contenu.cycleCount=(state.agents.contenu.cycleCount||0)+1;
    setAgent('contenu','idle',{lastRun:new Date().toISOString()});
  }catch(e){
    logAction('contenu','Erreur: '+e.message,'error');
    setAgent('contenu','error');
    if(e.message.includes('429')) addAlert('api_limit','Limite Anthropic atteinte — quota insuffisant','contenu');
  }
}

// ════════════════════════════════════════════════════════════════
//  AGENT PUB
// ════════════════════════════════════════════════════════════════
function runPub(){
  const signals=getMessages('pub',true); markRead('pub');
  const sched=signals.find(m=>m.type==='schedule_update');
  if(sched?.data?.bestHours){ state.strategy.bestHours=sched.data.bestHours; logAction('pub','Horaires mis à jour: '+state.strategy.bestHours.join('h,')+'h','success'); }
  const pending=Object.values(state.publishQueue).filter(v=>v.status==='scheduled').length;
  logAction('pub',pending+' vidéo(s) planifiée(s)');
  Object.entries(state.publishQueue).forEach(([fn,v])=>{ if(v.status==='scheduled'&&v.scheduledAt&&new Date(v.scheduledAt)<=new Date()) publierVideo(fn); });
  state.agents.pub.cycleCount=(state.agents.pub.cycleCount||0)+1;
  setAgent('pub','idle',{lastRun:new Date().toISOString()});
}

async function publierVideo(filename){
  const v=state.publishQueue[filename];
  if(!v||!state.tiktokToken) return;
  v.status='uploading'; setAgent('pub','running');
  try{
    const buf=fs.readFileSync(v.filePath);
    const size=buf.length;
    const cap=((v.caption||v.titre||'').slice(0,150)+'\n\n'+(v.hashtags||[]).map(h=>'#'+h.replace('#','')).join(' ')).trim();
    const init=await fetch('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/',{
      method:'POST', headers:{'Authorization':'Bearer '+state.tiktokToken,'Content-Type':'application/json; charset=UTF-8'},
      body:JSON.stringify({post_info:{title:cap.slice(0,150),privacy_level:'SELF_ONLY',disable_duet:false,disable_comment:false,disable_stitch:false},source_info:{source:'FILE_UPLOAD',video_size:size,chunk_size:size,total_chunk_count:1}})
    });
    const id=await init.json();
    if(!id?.data?.publish_id) throw new Error('Init échoué');
    v.tiktokPublishId=id.data.publish_id;
    await fetch(id.data.upload_url,{method:'PUT',headers:{'Content-Type':'video/webm','Content-Range':'bytes 0-'+(size-1)+'/'+size,'Content-Length':String(size)},body:buf});
    for(let i=0;i<10;i++){
      await sleep(5000);
      const st=await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/',{method:'POST',headers:{'Authorization':'Bearer '+state.tiktokToken,'Content-Type':'application/json; charset=UTF-8'},body:JSON.stringify({publish_id:id.data.publish_id})});
      const sd=await st.json();
      if(sd?.data?.status==='PUBLISH_COMPLETE'||sd?.data?.status==='SEND_TO_USER_INBOX'){
        v.status='published'; v.publishedAt=new Date().toISOString();
        logAction('pub','✅ Publié: "'+v.titre+'"','success');
        sendMessage('pub','analytics','video_published',{titre:v.titre},'high');
        try{fs.unlinkSync(v.filePath);}catch(e){}
        break;
      }
      if(sd?.data?.status==='FAILED') throw new Error('TikTok a refusé la vidéo');
    }
  }catch(e){
    v.status='error'; v.error=e.message;
    logAction('pub','Erreur: '+e.message,'error');
    if(e.message.includes('401')) addAlert('api_limit','Token TikTok expiré','pub');
  }
  setAgent('pub','idle',{lastRun:new Date().toISOString()});
}

// ════════════════════════════════════════════════════════════════
//  ORCHESTRATEUR — cycle toutes les heures
// ════════════════════════════════════════════════════════════════
async function runOrchestrator(){
  logAction('orchestrateur','═══ Cycle démarré ═══');
  await runAnalytics(); await sleep(2000);
  await runVeille();    await sleep(2000);
  await runContenu();   await sleep(1000);
  runPub();
  logAction('orchestrateur','═══ Cycle terminé ═══','success');
}

cron.schedule('0 * * * *', runOrchestrator);
cron.schedule('*/5 * * * *', ()=>{ Object.entries(state.publishQueue).forEach(([fn,v])=>{ if(v.status==='scheduled'&&v.scheduledAt&&new Date(v.scheduledAt)<=new Date()) publierVideo(fn); }); });

// ════════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════════
app.get('/', (req,res)=>res.json({status:'ok',message:'TikTok Agent Suite v2',queue:Object.keys(state.publishQueue).length}));

app.get('/dashboard', (req,res)=>res.json({
  agents:state.agents, strategy:state.strategy,
  analytics:{...state.analytics,videos:state.analytics.videos.slice(0,5)},
  alerts:state.alerts.filter(a=>!a.resolved),
  scripts:state.scripts.slice(0,10).map(s=>({id:s.id,titre:s.titre,status:s.status,niche:s.niche,createdAt:s.createdAt})),
  publishQueue:Object.fromEntries(Object.entries(state.publishQueue).map(([k,v])=>[k,{titre:v.titre,status:v.status,scheduledAt:v.scheduledAt,publishedAt:v.publishedAt,error:v.error}])),
  messageBus:state.messageBus.slice(0,30),
  actionLog:state.actionLog.slice(0,50),
  credentials:{tiktok:!!state.tiktokToken,anthropic:!!state.anthropicKey,elevenlabs:!!state.elevenLabsKey},
}));

app.post('/configure',(req,res)=>{
  const{token,open_id,anthropic_key,elevenlabs_key,pexels_key,niche,ton}=req.body;
  if(token){state.tiktokToken=token; logAction('system','Token TikTok configuré','success');}
  if(open_id) state.tiktokOpenId=open_id;
  if(anthropic_key){state.anthropicKey=anthropic_key; logAction('system','Clé Anthropic configurée','success');}
  if(elevenlabs_key){state.elevenLabsKey=elevenlabs_key; logAction('system','Clé ElevenLabs configurée','success');}
  if(pexels_key) state.pexelsKey=pexels_key;
  if(niche){state.strategy.niche=niche; logAction('system','Niche: '+niche,'info');}
  if(ton) state.strategy.ton=ton;
  res.json({ok:true});
});

app.post('/schedule', upload.single('video'), (req,res)=>{
  if(!req.file) return res.status(400).json({error:'Fichier requis'});
  const{titre,caption,hashtags,scheduled_at}=req.body;
  const fn=req.file.originalname||req.file.filename;
  const sa=scheduled_at?new Date(scheduled_at):null;
  state.publishQueue[fn]={titre,caption,filePath:req.file.path,fileSize:req.file.size,hashtags:hashtags?JSON.parse(hashtags):[],scheduledAt:sa,status:sa&&sa>new Date()?'scheduled':'pending',addedAt:new Date().toISOString(),error:null,tiktokPublishId:null};
  if(sa&&sa>new Date()){ const d=sa.getTime()-Date.now(); setTimeout(()=>publierVideo(fn),d); logAction('pub','Planifié: "'+titre+'" dans '+Math.round(d/60000)+'min'); }
  else setImmediate(()=>publierVideo(fn));
  res.json({ok:true,filename:fn,status:state.publishQueue[fn].status});
});

app.get('/status',(req,res)=>res.json({ok:true,queue:state.publishQueue,token_set:!!state.tiktokToken}));
app.get('/messages',(req,res)=>res.json({messages:state.messageBus.slice(0,50)}));
app.get('/logs',(req,res)=>res.json({logs:state.actionLog.slice(0,100)}));
app.get('/alerts',(req,res)=>res.json({alerts:state.alerts}));
app.post('/alerts/:id/resolve',(req,res)=>{ const a=state.alerts.find(a=>a.id===parseInt(req.params.id)); if(a) a.resolved=true; res.json({ok:true}); });
app.get('/scripts',(req,res)=>res.json({scripts:state.scripts}));
app.post('/run/:agent',async(req,res)=>{
  const{agent}=req.params; res.json({ok:true,message:'Agent '+agent+' démarré'});
  if(agent==='analytics') await runAnalytics();
  else if(agent==='veille') await runVeille();
  else if(agent==='contenu') await runContenu();
  else if(agent==='pub') runPub();
  else if(agent==='all') await runOrchestrator();
});
app.get('/strategy',(req,res)=>res.json({strategy:state.strategy}));
app.post('/strategy',(req,res)=>{ Object.assign(state.strategy,req.body); state.strategy.lastUpdated=new Date().toISOString(); logAction('system','Stratégie mise à jour','info'); res.json({ok:true,strategy:state.strategy}); });

app.listen(PORT,()=>{
  console.log('\n🤖 TikTok Agent Suite v2 — port '+PORT);
  logAction('system','Serveur démarré','success');
  setTimeout(runOrchestrator,30000);
});
