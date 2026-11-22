// Exercise the real VideoBaseTexture -> Texture -> Sprite -> CanvasRenderer path of
// RPG Maker MV's unmodified PixiJS 4.5.4, with a DETACHED video, not GameVideo.
import {execFileSync} from 'node:child_process'; import {captureScreen} from './texture-capture.mjs'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import {performance} from 'node:perf_hooks'; import {setTimeout as sleep} from 'node:timers/promises';
import assert from 'node:assert/strict'; import {packageInput,sha} from './package-input.mjs'; import {boot} from './host.mjs';
const [zip,pixiPath,report,mode='scaled',expect='fixed']=process.argv.slice(2);
if(!report||!['direct','scaled'].includes(mode)||!['fixed','old'].includes(expect))throw Error('usage: pixi-texture.mjs card.zip stock-pixi.js report.json [scaled|direct] [fixed|old]');
const hash='47097d24b261679366419f9e36196a3303c35fa3d06d0518edb7f1ab5417def0';const pixi=fs.readFileSync(pixiPath);assert.equal(sha(pixi),hash);
const pack=await packageInput(zip),g='sdmc:/BurialNX-CG-check/www/',files=new Map(pack.files);
const entry=n=>execFileSync('unzip',['-p',zip,'BurialNX-Pixi-CG/www/'+n],{maxBuffer:3*1024*1024});
const hasBundledFixture=execFileSync('unzip',['-Z1',zip],{encoding:'utf8'}).split('\n').includes('BurialNX-Pixi-CG/www/index.html');
const originals=new Map([['index.html',fs.readFileSync(new URL('../fixtures/pixi-cg/www/index.html',import.meta.url))],['js/rpg_core.js',fs.readFileSync(new URL('../fixtures/pixi-cg/www/js/rpg_core.js',import.meta.url))],['js/pixi.js',pixi],['movies/sync.mp4',pack.files.get(g+'movies/sync.mp4')],['movies/sync.webm',pack.files.get(g+'movies/sync.webm')],['movies/broken.webm',Buffer.from([0x1a,0x45,0xdf,0xa3,0xff,0,0,0,0,0,0,0,0,0,0,0])],['movies/mislabeled.webm',Buffer.from('Intentionally not a media file.')]]);
const fixtureHashes={};for(const [name,b] of originals){const bytes=hasBundledFixture?entry(name):b;assert.equal(sha(bytes),sha(b));files.set(g+name,bytes);fixtureHashes[name]=sha(bytes);}
const outputVideo=process.argv[7];let rec=null;
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'burialnx-pixi-'));let host;
try {
 host=await boot({...pack,files},scratch,mode);const {screen,W,H,state,cx}=host;
 const m=[0,1].map(()=>({hashes:new Set(),white:[],tone:[],left:0,right:0,bright:false,sounding:false,offColor:0,samples:0}));
 const near=(a,c)=>c.every((v,i)=>Math.abs(a[i]-v)<=2);
 const scale=Math.min(W/816,H/624),x=(W-816*scale)/2,y=(H-624*scale)/2;
 const probe=(gx,gy,w=1,h=1)=>screen.getContext('2d').getImageData(Math.round(x+gx*scale),Math.round(y+gy*scale),w,h).data;
 if(outputVideo)rec=captureScreen(scratch,W,H);
 const start=performance.now();let entered=-1,restored=false,last=0,doneAt=-1;
 for(let i=0;i<800;i++){
  const t=Math.round(i*1024/48);state.t=t;state.pressA=t>=400&&t<520;const pcm=host.pumpAudio(1024);host.pumpFrames();last=t;if(rec)await rec.tick(screen,pcm,t);if(state.fatal)throw state.fatal;
  const d=cx.textureTest;if(d?.phase==='error')throw Error(d.why);
  if(!d && state.texts.some(s=>s.includes('could not start')))throw Error('Guest startup: '+state.lastText.join(';'));
  if(d?.clips.length && d.phase==='test'){
   if(entered<0)entered=t;const idx=d.clips.length-1,k=m[idx],v=d.clips[idx];
   if(!v.ends){const a=probe(345,276,55,38);let hash=2166136261,luma=0,n=0;for(let p=0;p<a.length;p+=4*13){for(let j=0;j<3;j++){hash=Math.imul(hash^a[p+j],16777619);luma+=a[p+j];n++;}}k.hashes.add(hash);const bright=luma/n>235;if(bright&&!k.bright)k.white.push(t);k.bright=bright;
    let ss=0,rr=0;for(let p=0;p<pcm.length;p+=4){ss+=(pcm.readInt16LE(p)/32768)**2;rr+=(pcm.readInt16LE(p+2)/32768)**2;}const l=Math.sqrt(ss/(pcm.length/4)),r=Math.sqrt(rr/(pcm.length/4));k.left=Math.max(k.left,l);k.right=Math.max(k.right,r);const sound=l>.035&&r>.035;if(sound&&!k.sounding)k.tone.push(t);k.sounding=sound;
    if(near(probe(85,110),[23,48,70,255]))k.offColor++;k.samples++;}
  }
  if(d?.phase==='returned' && near(probe(408,312),[36,109,59,255])){restored=true;if(doneAt<0)doneAt=t;if(!rec||t-doneAt>750)break;}
  if(expect==='old' && entered>=0 && t-entered>=1650 && host.movies.size===0)break;
  await sleep(Math.max(0,start+(i+1)*1024/48-performance.now()));
 }
 const d=cx.textureTest||{phase:'not-started',clips:[]};
 const res={scope:'Actual packaged application and same-tag decoder on macOS, unmodified MV-bundled PixiJS. Final display pixels and stereo PCM measured; not a Switch hardware run.',pixiVersion:d.version,pixiSha256:hash,fixtureHashes,gameReadFromShipZip:hasBundledFixture,zipSha256:sha(fs.readFileSync(zip)),nroSha256:pack.provenance.nroSha256,mode,phase:d.phase,nativeOpens:host.movies.size,restoredGamePixels:restored,assetReads:state.reads.filter(s=>s.includes('/movies/')).map(s=>s.split('/').at(-1)),clips:d.clips.map((v,i)=>{const k=m[i];const offsets=k.white.length===4&&k.tone.length===4?k.white.map((t,j)=>Math.abs(k.tone[j]-t)):[];return {...v,distinctPixelSamples:k.hashes.size,peakStereoRms:[+k.left.toFixed(4),+k.right.toFixed(4)],whiteOnsetsMs:k.white,toneOnsetsMs:k.tone,offsetsMs:offsets,spriteBackgroundIntact:k.offColor>=Math.max(1,k.samples-3)};})};
 const check=(c,i)=>c.detached&&c.loaded===1&&c.ready===1&&c.plays===1&&c.ends===1&&!c.errors&&c.w===640&&c.h===360&&c.currentSrc==='movies/sync.'+(i?'webm':'mp4')&&c.directSrc===''&&c.distinctPixelSamples>=40&&c.peakStereoRms.every(x=>x>.055)&&c.spriteBackgroundIntact&&c.offsetsMs.length===4&&c.offsetsMs.every(n=>n<=125);
 res.passed=d.version==='4.5.4'&&restored&&d.clips.length===2&&res.clips.every(check)&&res.clips[1].rejected.join('|')==='movies/missing-file.webm|movies/mislabeled.webm|movies/broken.webm'&&!res.assetReads.includes('never-use.mp4');
 res.reproducedBlankCandidateBug=d.version==='4.5.4'&&d.clips.length===1&&d.clips[0].sourceChildren===1&&res.nativeOpens===0&&d.clips[0].plays===0&&res.clips[0].distinctPixelSamples===1&&res.clips[0].peakStereoRms.every(x=>x===0);
 if(rec){const result=await rec.finish(res.passed?outputVideo:undefined);Object.assign(res,result);}
 fs.writeFileSync(report,JSON.stringify(res,null,2)+'\n');console.log(JSON.stringify(res,null,2));if(expect==='old'?!res.reproducedBlankCandidateBug:!res.passed)process.exitCode=1;
} finally {rec?.close();host?.close();fs.rmSync(scratch,{recursive:true,force:true});}
