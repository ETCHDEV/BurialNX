// End-to-end desktop acceptance: use the application, runtime JS and fixture FROM
// the install ZIP, not source imports or a media-element mock. For --capture the
// only encoder inputs are the READ BACK screen pixels and the rendered PCM bus.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {packageInput,sha} from './package-input.mjs';
import {boot} from './host.mjs';
const [zip,mode='scaled',report,capture]=process.argv.slice(2);
if(!zip||!['scaled','direct'].includes(mode))throw Error('usage: node --experimental-vm-modules run.mjs SD.zip scaled|direct [report.json] [captured.mp4]');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'burialnx-packed-'));
const bits=await packageInput(zip),fault=process.env.CG_NEGATIVE==='av-off';
let host,encoder,videoDone,pcmFile,closing=false,encoded=0;const sc=new Map();
function stat(k){if(!sc.has(k))sc.set(k,{file:k,pixels:new Set(),flashAtMs:[],toneAtMs:[],maxPcmRms:[0,0],samples:0,lastWhite:false,lastTone:false});return sc.get(k);}
function screenSample(host,rec,t,pcm){
 const {screen,W,H}=host;const ctx=screen.getContext('2d');const c=ctx.getImageData(Math.floor(W*.25),Math.floor(H*.32),Math.floor(W*.50),Math.floor(H*.36));
 let hash=2166136261,sum=0,n=0;for(let y=3;y<c.height;y+=13)for(let x=4;x<c.width;x+=19){const k=4*(y*c.width+x);for(let j=0;j<3;j++){let u=c.data[k+j];sum+=u;hash=Math.imul(hash^u,16777619);n++;}}
 const white=sum/n>235;if(white&&!rec.lastWhite)rec.flashAtMs.push(t);rec.lastWhite=white;rec.pixels.add(hash);rec.samples++;
 let ss=[0,0];for(let i=0;i<pcm.length;i+=4){let a=pcm.readInt16LE(i)/32768,b=pcm.readInt16LE(i+2)/32768;ss[0]+=a*a;ss[1]+=b*b;}
 let rms=ss.map(v=>Math.sqrt(v/(pcm.length/4)));const tone=rms.some(v=>v>.03);if(tone&&!rec.lastTone)rec.toneAtMs.push(t);rec.lastTone=tone;rec.maxPcmRms=rms.map((v,i)=>Math.max(v,rec.maxPcmRms[i]));
}
try {
 host=await boot(bits,scratch,mode);const {W,H,state,screen}=host;let gameDirect;
 if(capture){if(fault)throw Error('Do not publish negative control as a normal capture');pcmFile=fs.openSync(path.join(scratch,'out.pcm'),'w');
   encoder=spawn('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-f','rawvideo','-pix_fmt','rgba','-video_size',`${W}x${H}`,'-framerate','24','-i','pipe:0','-an','-c:v','libx264','-pix_fmt','yuv420p','-preset','veryfast','-crf','18',path.join(scratch,'screen.mp4')],{stdio:['pipe','ignore','inherit']});videoDone=once(encoder,'exit');}
 const start=performance.now();let animated=-1,completion=-1,capturedEnd=-1,verifiedReturn=false,sentA=false,replayed=false,poll,after;
 for(let i=0;i<2450;i++){
   // nx.js renders 128-sample quanta. A 480-frame call advances four full
   // quanta (512) while returning 480 samples, which distorts a capture clock.
   // Pull an exact multiple, use the emitted stereo sample count as the timeline.
   const block=1024, stepMs=block/48;
   const t=Math.round(i*stepMs);state.t=t;host.observe();const pcm=host.pumpAudio(block);
   const want=Math.floor(t*60/1000);if(want>animated){host.pumpFrames();animated=want;}
   const el=host.observe();if(gameDirect===undefined&&el){const gc=host.cx.document.getElementById('GameCanvas');if(gc&&typeof gc.direct==='boolean')gameDirect=gc.direct;}if(state.fatal)throw state.fatal;
   if(el&&el.src&&(!sentA)&&(el.style.opacity>0||state.events.some(e=>e.file===el.src.split('/').pop()&&e.type==='play')&&!el.ended))screenSample(host,stat(el.src.split('/').pop()),t,pcm);
   if(capture && !closing){fs.writeSync(pcmFile,pcm);const goal=Math.floor(t*24/1000)+1;while(encoded<goal){const image=screen.getContext('2d').getImageData(0,0,W,H);const ok=encoder.stdin.write(Buffer.from(image.data.buffer,image.data.byteOffset,image.data.byteLength));if(!ok)await once(encoder.stdin,'drain');encoded++;}}
   if(completion<0&&state.texts.includes('DONE: both movies ended; game control returned.')) completion=t;
   if(completion>=0&&!verifiedReturn&&t>=completion+200){const p=screen.getContext('2d').getImageData(Math.floor(W/2),Math.floor(H*.86),1,1).data;verifiedReturn=p[0]===22&&p[1]===50&&p[2]===71&&Number(el?.style.opacity)===0;}
   if(completion>=0&&verifiedReturn&&t>=completion+850&&!sentA){closing=true;capturedEnd=t+stepMs;sentA=true;state.pressA=true;}
   if(sentA&&t>capturedEnd+60)state.pressA=false;
   if(sentA&&state.events.filter(e=>e.type==='play'&&e.file==='sync.mp4').length===2){replayed=true;break;}
   if(i>350 && !el && state.texts.some(x=>/game could not start|fatal error/i.test(x)))break;
   await sleep(Math.max(0,start+(i+1)*stepMs-performance.now()));
 }
 const clips=[];let passed=true;
 for(const name of ['sync.mp4','sync.webm']){
   const r=stat(name),events=state.events.filter(e=>e.file===name && (capturedEnd<0||e.ms<capturedEnd));const on=x=>events.filter(v=>v.type===x);
   const offsets=r.toneAtMs.length===4 && r.flashAtMs.length===4?r.flashAtMs.map((v,i)=>Math.abs(v-r.toneAtMs[i])):null;
   const onset=on('play')[0]?.ms??0;
   const cadence=a=>a.length===4&&a.every((v,i)=>Math.abs(v-onset-i*1000)<=160);
   const check={readyOnce:on('loadeddata').length===1,playOnce:on('play').length===1,endedOnce:on('ended').length===1,noError:on('error').length===0,movingScreen:r.pixels.size>=40,stereoSound:r.maxPcmRms.every(n=>n>.055),fourFlashTonePairs:cadence(r.toneAtMs)&&cadence(r.flashAtMs),syncWithin125ms:!!offsets&&offsets.every(n=>n<=125)};
   const s=Object.values(check).every(Boolean);passed=passed&&s;clips.push({name,pass:s,checks:check,distinctScreenSamples:r.pixels.size,peakStereoPCM_RMS:r.maxPcmRms.map(v=>+v.toFixed(4)),flashAtMs:r.flashAtMs,toneAtMs:r.toneAtMs,absOffsetsMs:offsets,firstPlayMs:onset,endedMs:on('ended')[0]?.ms});
 }
 const nativeStats=[...host.movies.values()].map(r=>({file:r.file,presented:r.s.presented,dropped:r.s.dropped}));
 const lifecycle=verifiedReturn&&replayed&&completion>=0&&gameDirect===(mode==='direct');passed=passed&&lifecycle;
 const result={scope:'Desktop; untouched NRO RomFS main.js, embedded nx.js Video and event modules, exact SD fixture. Same-tag native FFmpeg decoder/audio graph compiled on macOS; desktop platform bindings and Skia canvas. Not an execution of the Switch ARM binary or a physical speaker test.',mode,negativeControl:fault,passed,sdZipSha256:sha(fs.readFileSync(zip)),...bits.provenance,screen:{width:W,height:H,gameCanvasDirect:gameDirect},clips,ended2of2Painted:state.texts.some(v=>v.includes('Ended: 2/2')),postCutsceneGamePixels:verifiedReturn,replayAStartedThirdMovie:replayed,nativeStats};
 if(!result.ended2of2Painted){result.passed=false;passed=false;}
 if(!lifecycle || state.events.some(v=>v.type==='error'))console.error('Guest diagnostics',state.events,state.lastText,state.reads.slice(-20));
 if(capture){encoder.stdin.end();const [code]=await videoDone;if(code!==0)throw Error('screen encoder failed '+code);fs.closeSync(pcmFile);pcmFile=undefined;
   if(passed){execFileSync('ffmpeg',['-nostdin','-y','-v','error','-i',path.join(scratch,'screen.mp4'),'-f','s16le','-ar','48000','-ac','2','-i',path.join(scratch,'out.pcm'),'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','160k','-movflags','+faststart','-shortest','-metadata','comment=Desktop readback of unmodified BurialNX packaged JavaScript; not Switch hardware.',capture]);result.captureSha256=sha(fs.readFileSync(capture));result.captureFrames=encoded;}
 }
 if(fault)result.negativeControlWorked=!passed&&lifecycle&&clips.every(v=>!v.checks.movingScreen&&!v.checks.stereoSound&&v.checks.endedOnce);
 if(report)fs.writeFileSync(report,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
 if(fault?!result.negativeControlWorked:!passed)process.exitCode=1;
}finally{host?.close();if(pcmFile!==undefined)fs.closeSync(pcmFile);if(encoder?.exitCode===null){encoder.stdin.destroy();encoder.kill('SIGKILL');}fs.rmSync(scratch,{recursive:true,force:true});}
