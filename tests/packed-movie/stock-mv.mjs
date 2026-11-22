// Optional stress/compatibility test with MIT-licensed official MV core scripts.
// The entire Graphics, Game_Interpreter and ResourceHandler files are loaded
// from a checked upstream revision. Nothing replaces movie/wait/event methods.
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {performance} from 'node:perf_hooks';import {setTimeout as sleep} from 'node:timers/promises';
import {packageInput,sha} from './package-input.mjs';import {boot} from './host.mjs';
const [zip,stockDir,testMp4,report]=process.argv.slice(2);if(!report)throw Error('Usage: ... stock-mv.mjs card.zip original-core-js-dir synthetic-720p.mp4 report.json');
const pkg=await packageInput(zip),root='sdmc:/BurialNX-CG-check/www/',map=new Map();
const pins={'Graphics.js':'efdc3769856e6a96697a7ed0614c8aff93fa82d286531effe7d5cbc6b6343412','ResourceHandler.js':'a4c33601ce2f8fc7ebd366eb6644e8e1e857b18438e8ebe44ae073989b374d45','Game_Interpreter.js':'e08d305740540ea4ef832e3c75772c5b226a67c87803a7dfaf6888671a054bb0'};
for(const [f,d] of Object.entries(pins)){const b=readFileSync(join(stockDir,f));if(sha(b)!==d)throw Error('Unexpected MV source: '+f);map.set(root+'js/'+f,b);}
map.set(root+'index.html',Buffer.from(['Graphics','ResourceHandler','Game_Interpreter','rpg_core'].map(n=>`<script src="js/${n}.js"></script>`).join('\n')));
const mp4=readFileSync(testMp4);map.set(root+'movies/cinematic.mp4',mp4); // Intentionally no WebM by that name.
map.set(root+'js/rpg_core.js',Buffer.from(`// Only the scene and device scaffolding are synthetic. Movie and wait logic are the official MV functions.
globalThis.makeVideoPlayableInline=()=>{}; globalThis.Utils={isMobileDevice:()=>false};globalThis.StorageManager={};globalThis.LZString={};globalThis.SceneManager={isSceneChanging(){return false;}};globalThis.$gameMap={mapId:()=>1};globalThis.$gameMessage={isBusy:()=>false};
globalThis.storyCount=0;globalThis.waitFrames=0;globalThis.advancedWhileVisible=false;
globalThis.onload=function(){Graphics._width=816;Graphics._height=624;Graphics._realScale=1;Graphics._createCanvas();Graphics._createVideo();const ctx=Graphics._canvas.getContext('2d');const interpreter=new Game_Interpreter();globalThis.interpreter=interpreter;
interpreter.setup([{code:261,indent:0,parameters:['cinematic']},{code:355,indent:0,parameters:['advancedWhileVisible=Graphics.isVideoPlaying();storyCount++;']},{code:0,indent:0,parameters:[]}],1);
function tick(){interpreter.update();if(interpreter._waitMode==='video')waitFrames++;if(!Graphics.isVideoPlaying()){ctx.fillStyle='#14593c';ctx.fillRect(0,0,816,624);if(storyCount)ctx.fillText('STORY CONTINUED',90,180);}requestAnimationFrame(tick);}setTimeout(tick,150);};`));
const scratch=mkdtempSync(join(tmpdir(),'burialnx-stock-mv-'));let h;
try{h=await boot({...pkg,files:map},scratch,'scaled');const clockStart=performance.now(),tones=[],whites=[],pix=new Set();let prev=false,prevW=false,peak=0,returnPixel=false,metadata,firstBeat=-1,pixelDiagnostic;
 for(let i=0;i<1050;i++){
  const t=Math.round(i*1024/48);h.state.t=t;h.observe();const pcm=h.pumpAudio(1024);h.pumpFrames();const v=h.observe();if(h.state.fatal)throw h.state.fatal;
  if(v&&v.style.opacity>0){metadata=[v.videoWidth,v.videoHeight];let sum=0;for(let p=0;p<pcm.length;p+=2)sum+=(pcm.readInt16LE(p)/32768)**2;const rms=Math.sqrt(sum/(pcm.length/2));peak=Math.max(peak,rms);const tone=rms>.03;if(tone&&!prev)tones.push(t);prev=tone;
   const r=h.screen.getContext('2d').getImageData(236,120,168,120).data;let vhash=2166136261,avg=0,n=0;for(let y=2;y<120;y+=9)for(let x=3;x<168;x+=11){let k=4*(y*168+x);for(let b=0;b<3;b++){let u=r[k+b];vhash=Math.imul(vhash^u,16777619);avg+=u;n++;}}pix.add(vhash);const white=avg/n>235;if(white&&!prevW)whites.push(t);prevW=white;
  }
  if(h.cx.storyCount===1&&h.state.texts.includes('STORY CONTINUED')){const d=h.screen.getContext('2d').getImageData(320,260,1,1).data;const gc=h.cx.document.getElementById('GameCanvas');const off=gc.getContext('2d').getImageData(408,520,1,1).data;pixelDiagnostic={screen:[...d],gameCanvas:[...off],revision:gc.revision,canvasOpacity:gc.style.opacity};if(firstBeat<0)firstBeat=t;if(d[0]===20&&d[1]===89&&d[2]===60){returnPixel=true;break;}if(t-firstBeat>450)break;}
  if(t>3000&&(!v||v.error)&&h.state.texts.some(s=>/could not start|fatal error/i.test(s)))break;
  await sleep(Math.max(0,clockStart+(i+1)*1024/48-performance.now()));
 }
 const events=h.state.events.filter(e=>e.file==='cinematic.webm');const start=events.find(e=>e.type==='play')?.ms;const delta=whites.map((v,i)=>Math.abs(v-tones[i]));const check={actualStockMovieEventWaited:h.cx.waitFrames>350,storyExecutedOnce:h.cx.storyCount===1,notVisibleOnNextCommand:h.cx.advancedWhileVisible===false,gamePixelsRestored:returnPixel,
 stockRequestedWebm:events.some(e=>e.type==='loadstart'),onlyMp4ActuallyOpened:[...h.movies.values()].some(r=>r.file==='cinematic.mp4'),oneReadyOnePlayOneEnd:['loadeddata','play','ended'].every(t=>events.filter(e=>e.type===t).length===1)&&!events.some(e=>e.type==='error'),real720p:metadata?.[0]===1280&&metadata?.[1]===720,movingImage:pix.size>=180,audiblePCM:peak>.055,sevenPairs:tones.length===7&&whites.length===7,syncWithin125ms:delta.length===7&&delta.every(t=>t<=125),noLongDrift:[tones,whites].every(a=>a.length===7&&a.every((t,i)=>Math.abs(t-start-(500+i*2000))<=190))};
 const result={scope:'Official open-source MV event execution on the desktop host, no commercial game or physical Switch.',stockCommit:'182e31449707ba7e406db0485c44c2a9d11e2dcd',stockFileSha256:pins,nroSha256:pkg.provenance.nroSha256,testMovieSha256:sha(mp4),sourceVideoWidth:metadata?.[0],sourceVideoHeight:metadata?.[1],movieSeconds:14,pixelDiagnostic,stockCommandSequence:[261,355,0],waitFrames:h.cx.waitFrames,storyCount:h.cx.storyCount,distinctScreenSamples:pix.size,peakPCM_RMS:+peak.toFixed(4),flashAtMs:whites,toneAtMs:tones,absOffsetsMs:delta,check,passed:Object.values(check).every(Boolean)};
 if(!result.passed)console.error('diagnostics',h.state.events,h.state.lastText,h.state.reads.slice(-18));writeFileSync(report,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
}finally{h?.close();rmSync(scratch,{recursive:true,force:true});}
