// Original card fixture with stock MV command 261 -> command 355. The capture
// samples the final game display and the stereo PCM bus; no 'ended' injection.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {execFileSync} from 'node:child_process';import {setTimeout as sleep} from 'node:timers/promises';import {performance} from 'node:perf_hooks';import assert from 'node:assert/strict';
import {packageInput,sha} from './package-input.mjs';import {boot} from './host.mjs';import {captureScreen} from './texture-capture.mjs';
const [programZip,fixtureZip,report,expected='fixed',output]=process.argv.slice(2);if(!report||!['fixed','old'].includes(expected))throw Error('usage: ... unequal-tracks.mjs card.zip card-with-tail-fixture.zip result.json [old|fixed] [screen.mp4]');
const pkg=await packageInput(programZip),files=new Map(),hashes={};const root='sdmc:/BurialNX-CG-check/www/';
for(const n of ['index.html','js/rpg_core.js','js/Game_Interpreter.js','js/ResourceHandler.js','js/Graphics.js','movies/short-audio.mp4','movies/short-video.webm']){const b=execFileSync('unzip',['-p',fixtureZip,'BurialNX-Tail-CG/www/'+n],{maxBuffer:8*1024*1024});files.set(root+n,b);hashes[n]=sha(b);}
assert.equal(hashes['js/Game_Interpreter.js'],'e08d305740540ea4ef832e3c75772c5b226a67c87803a7dfaf6888671a054bb0');assert.equal(hashes['js/Graphics.js'],'efdc3769856e6a96697a7ed0614c8aff93fa82d286531effe7d5cbc6b6343412');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'bnx-tail-'));let h,rec;
try{h=await boot({...pkg,files},scratch,'scaled');if(output)rec=captureScreen(scratch,h.W,h.H);
 const states=[0,1].map(()=>({displayGreen:[],audioWindows:[],mov:new Set(),sampled:0,maxTime:0,backsteps:0,lastTime:0,energy:[0,0],projections:[[0,0,0,0],[0,0,0,0]],afterQuiet:0,afterPeak:0}));
 const start=performance.now();let doneAt=-1,middle=false,done=false;const near=(c,rgb)=>rgb.every((v,i)=>Math.abs(v-c[i])<=2);
 const ctx=h.screen.getContext('2d');let seenDone=0;
 for(let i=0;i<665;i++){
  const t=Math.round(i*1024/48);h.state.t=t;h.state.pressA=t>=400&&t<510;h.observe();const pcm=h.pumpAudio(1024);h.pumpFrames();const v=h.observe();if(h.state.fatal)throw h.state.fatal;
  if(rec)await rec.tick(h.screen,pcm,t);
  const guest=h.cx.tailTest;const src=v?.src||'';const idx=src.includes('short-video')?1:src.includes('short-audio')?0:-1;
  if(v&&idx>=0&&+v.style.opacity>0){const s=states[idx],beg=h.state.events.find(e=>e.file===v.src.split('/').at(-1)&&e.type==='play')?.ms;
   if(beg!==undefined){const dt=t-beg;const im=ctx.getImageData(228,130,178,99).data;let green=true,hash=2166136261;for(let p=0;p<im.length;p+=4*29){green&&=(im[p+1]>165&&im[p]<85&&im[p+2]<125&&im[p+3]>240);for(let j=0;j<3;j++)hash=Math.imul(hash^im[p+j],16777619);}s.mov.add(hash);s.sampled++;if(green)s.displayGreen.push(dt);
    const tt=v.currentTime;s.maxTime=Math.max(s.maxTime,tt);if(tt+.03<s.lastTime)s.backsteps++;s.lastTime=tt;
    const energy=[0,0];for(let j=0;j<1024;j++)for(let c=0;c<2;c++){const x=pcm.readInt16LE(4*j+2*c)/32768;energy[c]+=x*x;if(dt>150&&dt<780){const pos=(i*1024+j)/48000,arr=s.projections[c];arr[0]+=x*Math.cos(2*Math.PI*440*pos);arr[1]+=x*Math.sin(2*Math.PI*440*pos);arr[2]+=x*Math.cos(2*Math.PI*880*pos);arr[3]+=x*Math.sin(2*Math.PI*880*pos);}}
    const rms=energy.map(x=>Math.sqrt(x/1024));s.energy=s.energy.map((x,j)=>Math.max(x,rms[j]));if(rms.every(r=>r>.03))s.audioWindows.push(dt);
    if(!idx&&dt>1350){s.afterQuiet++;s.afterPeak=Math.max(s.afterPeak,...rms);}
   }
  }
  const p=ctx.getImageData(320,260,1,1).data;if(guest?.storyCount===1&&near(p,[51,68,153]))middle=true;
  if(guest?.storyCount===2&&guest.phase==='done'&&near(p,[131,47,85])&&h.state.texts.some(v=>v.startsWith('DONE 2/2'))){seenDone++;if(doneAt<0)doneAt=t;if(seenDone>4)done=true;if(done&&(!rec||t-doneAt>700))break;}
  if(expected==='old'&&t>6600)break;
  if(t>3000&&h.state.texts.some(v=>v.includes('game could not start')))throw Error('Game failed: '+h.state.lastText.join(';'));
  await sleep(Math.max(0,start+(i+1)*1024/48-performance.now()));
 }
 const d=h.cx.tailTest||{};const result={scope:'Desktop capture of real NRO application/js runtime, stock MV 261/355, and a native decoder bound to the source matching this NRO. Not physical Nintendo Switch output.',nroSha256:pkg.provenance.nroSha256,armExeSha256:pkg.provenance.armExecutableSha256,fixtureHashes:hashes,middleSceneReachedScreen:middle,finalSceneReachedScreen:done,storyCount:d.storyCount,waitFrames:d.waitFrames,advancedWhileVideoVisible:d.advancedOverVideo,clips:[]};
 for(const [i,s] of states.entries()){
  const name=i?'short-video':'short-audio';const events=h.state.events.filter(e=>e.file===name+'.webm');const b=events.find(e=>e.type==='play')?.ms,e=events.find(e=>e.type==='ended')?.ms,qual=[...h.movies.values()].find(r=>r.file.startsWith(name))?.s;
  const A=s.projections.map(q=>[Math.hypot(q[0],q[1]),Math.hypot(q[2],q[3])]);
  result.clips.push({name,openedAsset:[...h.movies.values()].find(r=>r.file.startsWith(name))?.file,ready:events.filter(e=>e.type==='loadeddata').length,play:events.filter(e=>e.type==='play').length,ended:events.filter(e=>e.type==='ended').length,error:events.some(e=>e.type==='error'),playAtMs:b??null,endAtMs:e??null,elapsedMs:e==null||b==null?null:e-b,maxMediaTime:+s.maxTime.toFixed(3),backsteps:s.backsteps,presented:qual?.presented??0,dropped:qual?.dropped??0,screenSamples:s.sampled,distinctPixels:s.mov.size,greenFromMs:s.displayGreen[0]??null,greenThroughMs:s.displayGreen.at(-1)??null,stereoAudibleFromMs:s.audioWindows[0]??null,stereoAudibleThroughMs:s.audioWindows.at(-1)??null,peakChannelRms:s.energy,tailSilenceWindows:s.afterQuiet,tailSilencePeak:s.afterPeak,correctChannelOrder:A[0][0]>6*A[0][1]&&A[1][1]>6*A[1][0]});
 }
 const [a,b]=result.clips;result.passed=middle&&done&&result.storyCount===2&&Array.isArray(result.advancedWhileVideoVisible)&&result.advancedWhileVideoVisible.length===2&&result.advancedWhileVideoVisible.every(x=>x===false)&&result.clips.every(v=>v.ready===1&&v.play===1&&v.ended===1&&!v.error&&v.elapsedMs>=3800&&v.elapsedMs<=4300&&v.maxMediaTime>=3.85&&v.correctChannelOrder&&v.backsteps===0)&&a.openedAsset==='short-audio.mp4'&&a.greenFromMs>=3375&&a.greenFromMs<=3650&&a.greenThroughMs>3850&&a.stereoAudibleThroughMs>850&&a.stereoAudibleThroughMs<1150&&a.tailSilenceWindows>90&&a.tailSilencePeak<.003&&b.openedAsset==='short-video.webm'&&b.greenFromMs>580&&b.greenFromMs<920&&b.greenThroughMs>3850&&b.stereoAudibleThroughMs>3820;
 result.reproducedCg4Hang=!middle&&!done&&result.storyCount===0&&a.play===1&&a.ended===0&&!a.error&&a.maxMediaTime<1.3&&a.greenFromMs===null&&a.stereoAudibleThroughMs>850&&a.backsteps>0;
 if(rec)Object.assign(result,await rec.finish(result.passed?output:undefined));fs.writeFileSync(report,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));if(expected==='old'?!result.reproducedCg4Hang:!result.passed)process.exitCode=1;
}finally{rec?.close();h?.close();fs.rmSync(scratch,{recursive:true,force:true});}
