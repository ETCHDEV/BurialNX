// Original, disposable MV-shaped self-test; not a copy or modification of a commercial game.
// Rendering deliberately goes through the real loader. Flash, motion and return checks
// read the final screen, never the input film or the game's offscreen canvas.
globalThis.StorageManager = {}; globalThis.LZString = {};
globalThis.Graphics = {_width:816,_height:624, render() { this.paint?.(); }};
globalThis.onload = function () {
  const kit=globalThis.CGDeviceCheck,fs=globalThis.Switch;
  const canvas=document.createElement('canvas');canvas.id='GameCanvas';canvas.width=816;canvas.height=624;document.body.appendChild(canvas);
  const ctx=canvas.getContext('2d');const movie=document.createElement('video');movie.id='GameVideo';movie.style.opacity=0;
  movie.setAttribute('playsinline','');movie.volume=.85;document.body.appendChild(movie);
  const real=screen.getContext('2d');let probe=null;
  try{probe=new OffscreenCanvas(32,18).getContext('2d');}catch{}
  const now=()=>performance.now(); const round=n=>Number.isFinite(n)?Math.max(0,Math.round(n)):0;
  const keys=['reference','personalMp4','personalWebm'];
  const labels=['Two reference clips (MP4 + WebM)','My own MP4','My own WebM'];
  const questions=['Did the picture MOVE on your display?','Did you HEAR the sound?','Did the sound match the picture?'];
  const observations=['picture','sound','sync'];const marks=[[22,147,98],[158,44,109]];
  let phase='choose',sel=0,buildVersion=null,report,config,clip,aux,seq=0,clipNum=0,q=0,marker=0,entered=now(),dirty=true,released=false,prev=0,file='',saveError='';
  const writeLock=()=>{released=false;};
  // Never infer the running build from a hardcoded path. The NACP of argv[0] is
  // just build metadata, not a certificate that this is a physical Switch.
  const versionReady=Promise.race([kit.versionFromArgv(fs),new Promise(ok=>setTimeout(()=>ok(null),5000))]).then(v=>{buildVersion=v;if(report)report.nroDisplayVersion=v;dirty=true;});
  function go(p){phase=p;entered=now();dirty=true;writeLock();}
  function begin(){config=kit.options[keys[sel]];clipNum=0;q=0;file='';saveError='';
    report={schema:kit.schema,kitVersion:'1.0',expectedBuild:kit.build,nroDisplayVersion:buildVersion,run:keys[sel],physicalSwitch:null,
      clockSource:'device clock, not independently verified',soundEvidence:'operator only; no microphone, PCM capture or acoustic latency measurement',clips:[]};
    startClip();
  }
  function startClip(){
    const spec=config[clipNum],id=++seq;
    clip={id:spec.id,problem:null,events:{ready:0,ended:0},media:{width:0,height:0,durationMs:0,furthestMs:0,presentedFrames:0,droppedFrames:0},
      screen:{samples:0,distinct:0,sampleFailures:0,whiteOnsetsMediaMs:[]},returnMarkers:0,operator:{picture:null,sound:null,sync:null}};
    aux={hashes:new Set(),lastWhite:false,lastSample:-Infinity,started:now(),lastTime:0,lastProgress:now(),xSince:null};report.clips.push(clip);
    go('loading');movie.style.opacity=0;
    // Match stock Graphics._playVideo: src, event properties, load(). The loader
    // must synthesize loadeddata from an actual native frame, not from this test.
    movie.src='movies/'+spec.file;
    movie.onloadeddata=()=>{if(id!==seq)return;clip.events.ready++;if(clip.events.ready!==1)return;
      movie.style.opacity=1;go('playing');aux.lastProgress=now();copyMedia();
      try{const p=movie.play();if(p?.catch)p.catch(()=>{if(id===seq)finish('play-rejected');});}catch{finish('play-rejected');}
    };
    movie.onerror=()=>{if(id===seq)finish('source-or-decoder-error');};
    movie.onended=()=>{if(id!==seq)return;clip.events.ended++;finish(null);};
    try{movie.load();}catch{finish('load-error');}
  }
  function copyMedia(){
    const m=clip.media; m.width=Math.max(m.width,round(movie.videoWidth));m.height=Math.max(m.height,round(movie.videoHeight));
    m.durationMs=Math.max(m.durationMs,round(movie.duration*1000));const t=round(movie.currentTime*1000);m.furthestMs=Math.max(m.furthestMs,t);
    try{const f=movie.getVideoPlaybackQuality?.();if(f){m.droppedFrames=Math.max(m.droppedFrames,round(f.droppedVideoFrames));m.presentedFrames=Math.max(m.presentedFrames,round(f.totalVideoFrames-f.droppedVideoFrames));}}catch{}
    if(Math.abs(t-aux.lastTime)>10){aux.lastTime=t;aux.lastProgress=now();}return t;
  }
  function measure(t){
    const s=clip.screen;let sum=0,count=0,h=2166136261;
    const add=(p,k)=>{for(let j=0;j<3;j++){sum+=p[k+j];count++;h=Math.imul(h^p[k+j],16777619);}};
    try{
      if(probe){try{probe.drawImage(screen,0,0,32,18);const p=probe.getImageData(0,0,32,18).data;
        for(let y=5;y<13;y++)for(let x=10;x<22;x++)add(p,4*(y*32+x));
      }catch{probe=null;sum=0;count=0;h=2166136261;}}
      if(!probe){for(const [x,y] of [[.38,.42],[.5,.5],[.62,.58]]){const p=real.getImageData(Math.floor(screen.width*x),Math.floor(screen.height*y),8,4).data;for(let i=0;i<p.length;i+=4)add(p,i);}}
      const white=count>0&&sum/count>235;if(white&&!aux.lastWhite&&s.whiteOnsetsMediaMs.length<12)s.whiteOnsetsMediaMs.push(t);
      aux.lastWhite=white;if(aux.hashes.size<256)aux.hashes.add(h);s.distinct=aux.hashes.size;s.samples++;
    }catch{s.sampleFailures++;}
  }
  function finish(problem){
    if(phase!=='loading'&&phase!=='playing')return;
    ++seq;try{copyMedia();}catch{}clip.problem=problem;
    movie.onloadeddata=movie.onerror=movie.onended=null;movie.style.opacity=0;
    try{movie.pause();movie.src='';}catch{}
    marker=0;go('return');
  }
  function ask(){q=0;go('answer');}
  function answer(value){clip.operator[observations[q++]]=value;if(q===3){if(++clipNum<config.length)go('next');else go('device');}else{dirty=true;writeLock();}}
  function summary(){report.clips.forEach(c=>{c.assessment=kit.assess(c);});report.verdict=kit.verdict(report);go('summary');}
  function save(){if(file||phase!=='summary')return;saveError='';go('saving');
    versionReady.then(()=>{report.nroDisplayVersion=buildVersion;report.verdict=kit.verdict(report);report.deviceClockUtc=new Date().toISOString();
      try{file=kit.save(fs,report);go('saved');}catch{saveError='Could not write/verify SD report. Your previous results are kept.';go('summary');}
    });
  }
  const mask=(gp)=>{let n=0;for(const i of [0,1,2,3,12,13])if(gp?.buttons?.[i]?.pressed)n|=(1<<i);return n;};
  function input(t){
    const bits=mask(navigator.getGamepads?.()?.[0]);if(!bits)released=true;const e=released?(bits&~prev):0;prev=bits;
    const key=i=>!!(e&(1<<i));
    if(phase==='choose'){
      if(key(12)||key(13)){sel=(sel+(key(12)?2:1))%3;dirty=true;}else if(key(1))go('confirm');
    }else if(phase==='confirm'){if(key(1))begin();else if(key(0))go('choose');}
    else if(phase==='answer'||phase==='device'){
      const v=key(1)?'yes':key(0)?'no':key(3)?'unsure':null;if(v){if(phase==='answer')answer(v);else{report.physicalSwitch=v;summary();}}
    }else if(phase==='next'){if(key(1))startClip();}
    else if(phase==='summary'){if(key(1))save();else if(key(0))go('choose');}
    else if(phase==='saved'){if(key(1)||key(0))go('choose');}
    else if(phase==='loading'||phase==='playing'){
      if(bits&(1<<2)){if(aux.xSince===null)aux.xSince=t;else if(t-aux.xSince>1400)finish('stopped-by-operator');}else aux.xSince=null;
    }
  }
  function paint(){
    if(phase==='playing')return;if(!dirty)return;dirty=false;
    ctx.fillStyle='#182a36';ctx.fillRect(0,0,816,624);ctx.font='28px sans-serif';ctx.fillStyle='#ffffff';ctx.fillText('BurialNX  /  CG device check',36,59,744);
    let y=118; const line=(s,color='#e3ecf1')=>{ctx.font='20px sans-serif';ctx.fillStyle=color;ctx.fillText(String(s),38,y,740);y+=37;};
    if(phase==='choose'){line('Choose a check. Nothing plays until you confirm.');for(let i=0;i<3;i++)line((sel===i?'>   ':'     ')+labels[i],sel===i?'#80ecc9':'#e3ecf1');line('D-pad up/down: select     A: continue');line('No microphone. No upload. Saving a local report is optional.');line('Loader metadata: '+(buildVersion||'unavailable'));}
    else if(phase==='confirm'){line(labels[sel]);if(sel===0){line('Each 4s clip has four white flashes and four short tones.','#ffd497');line('Skip this test if flashing images are uncomfortable.');}else{line('Copy your clip before launch, without converting it:');line('www/movies/'+kit.options[keys[sel]][0].file,'#80ecc9');line('This checks the clip, not every plugin in its original game.');}line('Use a comfortable volume. Hold X to stop.');line('A: start     B: back');}
    else if(phase==='loading'){line('Loading '+config[clipNum].file+' ...');line('Hold X to stop and record a problem.');}
    else if(phase==='return'){line('Checking return to game...');const rgb=marks[marker];ctx.fillStyle=`rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;ctx.fillRect(366,270,84,84);}
    else if(phase==='answer'){line('Clip: '+clip.id);line('Automatic: '+(clip.problem||`${clip.media.presentedFrames} presented | ${clip.screen.distinct} distinct samples | return ${clip.returnMarkers}/2`));if(config[Math.max(0,clipNum)]?.reference)line('Reference: four white flashes, each with one short tone.');line('Observation '+(q+1)+'/3: '+questions[q],'#80ecc9');line('A: Yes        B: No        Y: Not sure / not checked');line('Answer from what you actually saw and heard.');}
    else if(phase==='next'){line('Next: '+config[clipNum].file);line('A: start next clip');}
    else if(phase==='device'){line('Did you run this on a PHYSICAL Nintendo Switch?','#80ecc9');line('A: Yes     B: No (desktop/emulator)     Y: Not sure');}
    else if(phase==='summary'||phase==='saving'||phase==='saved'){
      line(report.verdict,'#80ecc9');for(const c of report.clips)line(c.id+': '+(c.problem||'motion '+c.screen.distinct+' / return '+c.returnMarkers+'/2')+' | sound: '+c.operator.sound+' | sync: '+c.operator.sync);
      if(phase==='saved'){line('Report saved locally:');line('SD:/switch/burialnx/CG-CHECK/');line(file,'#80ecc9');line('A: back to selection');}
      else if(phase==='saving')line('Saving...');else{if(saveError)line(saveError,'#ffd497');line('A: save local JSON     B: discard and return');line('No video, audio, screenshots, hardware IDs or network requests.');}
    }
  }
  Graphics.paint=paint;
  function frame(){const t=now();input(t);
    if(phase==='playing'){const mediaMs=copyMedia();if(!movie.paused){if(t-aux.lastSample>=90 && movie.style.opacity>0){aux.lastSample=t;measure(mediaMs);}}if(t-aux.lastProgress>35000)finish(movie.paused?'paused-without-progress':'movie-clock-stalled');}
    else if(phase==='loading'&&t-aux.started>50000)finish('no-first-frame');
    else if(phase==='return'){
      if(t-entered>80){try{const p=real.getImageData(Math.floor(screen.width/2),Math.floor(screen.height/2),1,1).data;
        if(marks[marker].every((v,i)=>Math.abs(v-p[i])<=2)&&p[3]>250){clip.returnMarkers++;if(marker===0){marker=1;entered=t;dirty=true;}else ask();}
      }catch{}}
      if(phase==='return'&&t-entered>4000)ask();
    }
    Graphics.render();requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
};
