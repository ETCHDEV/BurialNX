// Host adapters for the shipped JS. No adapter fires a canplay/ended/error event,
// invents a frame or sets the MV waiting flag. Only APIs normally provided by the
// platform are replaced. The real Video/event implementations are extracted from NRO.
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {deps} from './package-input.mjs';
import {sidecarSink} from './sidecar-sink.mjs';
const sk=deps('@napi-rs/canvas');
const au=createRequire(import.meta.url)(path.resolve(process.env.CG_DECODER));
const ab=b=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
export async function boot(pkg,scratch,mode) {
 const expectedDecoder=pkg.provenance.armExecutableSha256==='d19416181cc10974ac8b44f902fb0232f032f78e38021f7dbce1dcc3c2834cb6'?'ba3568226f639d12c0b820de662bcb8d09437438c8f11c5c4188c699d2761ced':pkg.provenance.armExecutableSha256==='b3f8593f44e22d0281d94c7a51bbfe96072f48ab1ee81eb7efa2998f84ffdbf4'?'54688adee86dd8c0d748ca260b9d51255ffe33189daf3f284c1783af21b5e00e':'63f1fc541f57dc44b802e99744e2e0f824d9f99668cc6c8402c529c13a5a2327';
 if(au.sourceSha256!==expectedDecoder)throw Error('Test decoder does not match the native program of this NRO; build the binding from its reviewed sources.');
 const W=mode==='direct'?816:640,H=mode==='direct'?624:360;
 const state={t:0,firstDraw:null,texts:[],reads:[],lastText:[],draws:0,events:[],fwd:'cgcheck',fatal:null};
 const resources=new Map(pkg.files),dirs=new Set(['sdmc:','sdmc:/BurialNX-CG-check','sdmc:/BurialNX-CG-check/www','sdmc:/BurialNX-CG-check/www/js','sdmc:/BurialNX-CG-check/www/movies','sdmc:/switch','sdmc:/switch/burialnx','sdmc:/switch/burialnx/test-saves']);
 const lib={version:1,games:[{id:state.fwd,name:'Original SD acceptance test',root:'sdmc:/BurialNX-CG-check/www',sharedSaves:false,saves:{kind:'sd',folder:'sdmc:/switch/burialnx/test-saves'},experimental:{skipPresent:true}}]};resources.set('sdmc:/switch/burialnx/library.json',Buffer.from(JSON.stringify(lib)));
 const trim=p=>String(p).replace(/\/+$/,'');const read=(p,range)=>{const k=trim(p),b=resources.get(k);if(!b)return null;if(state.reads.length<150&&!state.reads.includes(k))state.reads.push(k);return ab(range?b.subarray(range.start||0,range.end===undefined?undefined:range.end+1):b);};
 const sw={argv:['sdmc:/switch/burialnx/burialnx.nro','--game',state.fwd],readFileSync:read,readFile:async(p,r)=>read(p,r),
   readDirSync(p){const base=trim(p)+'/';if(!dirs.has(trim(p)))return null;return [...new Set([...resources.keys(),...dirs].filter(k=>k.startsWith(base)).map(k=>k.slice(base.length).split('/')[0]).filter(Boolean))];},
   statSync(p){const k=trim(p);return resources.has(k)?{mode:0o100644,size:resources.get(k).length}:dirs.has(k)?{mode:0o040755,size:0}:null;},
   mkdirSync(p){dirs.add(trim(p));},writeFileSync(p,b){resources.set(trim(p),Buffer.from(b));},appendFileSync(p,b){const k=trim(p);resources.set(k,Buffer.concat([resources.get(k)||Buffer.alloc(0),Buffer.from(b)]));},removeSync(p){resources.delete(trim(p));},renameSync(a,b){if(resources.has(a)){resources.set(b,resources.get(a));resources.delete(a);}},exit(){state.fatal=Error('Unexpected homebrew exit');}};
 const movies=new Map(),live=new Set(),decodedImages=new WeakMap();let firstNative=null;
 const sink={destination:{},createGain(){let v=1;const node={stream:null,destination:null,connect(dest){this.destination=dest;},gain:{get value(){return v;},set value(x){v=x;if(node.stream)au.gain(node.stream.handle,process.env.CG_NEGATIVE==='av-off'?0:x);}}};return node;}};
 const api={entrypoint:'romfs:/main.js',videoNew(){return {};},
   async videoLoad(obj,uri,input){
     let file=uri,backendSource;
     if(uri){const asset=resources.get(uri);if(!asset)throw Error('Missing test SD movie '+uri);file=path.basename(uri);backendSource=path.join(scratch,file);writeFileSync(backendSource,asset);}
     else {file='local-buffer';backendSource=Buffer.from(input);}
     const h=au.open(backendSource);const s=au.step(h,0);const rec={obj,handle:h,file,s,started:false,closed:false,frame:0,surface:null,quality:null};live.add(rec);movies.set(obj,rec);firstNative??=rec;
     return {width:s.width,height:s.height,duration:s.duration,hasAudio:s.hasAudio};
   },
   videoCreateAudioNode(o){return movies.get(o);},audioNodeConnect(stream,gain){gain.stream=stream;au.gain(stream.handle,process.env.CG_NEGATIVE==='av-off'?0:gain.gain.value);},
   videoSetLoop(o,v){au.loop(movies.get(o).handle,v);},videoPlay(o){let r=movies.get(o);au.play(r.handle);r.started=true;},videoPause(o){let r=movies.get(o);if(r&&!r.closed)au.pause(r.handle);},videoSeek(o,t){au.seek(movies.get(o).handle,t);},
   videoTick(o){const r=movies.get(o);if(r&&!r.closed)update(r,0);},
   videoState(o){const r=movies.get(o);if(!r||r.closed)return null;const s=r.s;return {currentTime:s.time,ended:s.ended,seeking:s.seeking,buffered:s.buffered,presentedFrames:s.presented,droppedFrames:s.dropped,error:s.error};},
   videoClose(o){const r=movies.get(o);if(!r||r.closed)return;au.close(r.handle);r.closed=true;live.delete(r);}
 };
 function update(r,count){
   const s=au.step(r.handle,count);r.s=s;
   if(s.frame?.length){
     const pixels=new Uint8ClampedArray(s.frame.length);for(let p=0;p<pixels.length;p+=4){pixels[p]=s.frame[p+2];pixels[p+1]=s.frame[p+1];pixels[p+2]=s.frame[p];pixels[p+3]=s.frame[p+3];}
     if(!r.surface)r.surface=sk.createCanvas(s.width,s.height);
     r.surface.getContext('2d').putImageData(new sk.ImageData(pixels,s.width,s.height),0,0);r.frame++;
   }
   return s.pcm;
 }
 const makeCanvas=(w,h,screenFlag=false)=>{
   const c=sk.createCanvas(w,h),x=c.getContext('2d'),draw=x.drawImage.bind(x),text=x.fillText.bind(x);
   x.drawImage=(input,...args)=>{const r=movies.get(input);if(r){if(r.surface){if(screenFlag){state.currentDrawn=r;state.draws++;}if(process.env.CG_NEGATIVE==='av-off')return;draw(r.surface,...args);}return;}const img=decodedImages.get(input);if(img===null)return;return draw(img||input,...args);};
   x.fillText=(t,...a)=>{const s=String(t);if(!state.texts.includes(s)&&state.texts.length<200)state.texts.push(s);if(!state.lastText.includes(s)){state.lastText.push(s);if(state.lastText.length>10)state.lastText.shift();}return text(t,...a);};
   return c;
 };
 const screen=makeCanvas(W,H,true), raf=new Map(),timers=new Map();let id=0;
 function timeout(cb,ms,...args){const k=++id;const t=setTimeout(()=>{timers.delete(k);try{cb(...args);}catch(e){state.fatal=e;}},ms);timers.set(k,t);return k;}
 function interval(cb,ms,...args){const k=++id;const t=setInterval(()=>{try{cb(...args);}catch(e){state.fatal=e;}},ms);timers.set(k,t);return k;}
 function clear(id){clearTimeout(timers.get(id));timers.delete(id);}
 function OffscreenCanvas(w,h){return makeCanvas(w,h);}
 // Only the PNG palette probe uses this adapter; its actual PNG is decoded by Skia.
 class HostImage extends EventTarget{set src(v){this.url=v;decodedImages.set(this,null);fetch(v).then(r=>r.arrayBuffer()).then(b=>sk.loadImage(Buffer.from(b))).then(img=>{decodedImages.set(this,img);this.width=img.width;this.height=img.height;this.dispatchEvent(new Event('load'));},()=>this.dispatchEvent(new Event('error')));}get src(){return this.url||'';}}
 const separate = process.env.CG_SIDECAR_NATIVE ? sidecarSink(sink,api,process.env.CG_SIDECAR_NATIVE,expectedDecoder) : null;
 const globals={...(separate?.globals||{}),screen,OffscreenCanvas,Switch:sw,Image:HostImage,navigator:{userAgent:'nx.js',platform:'Nintendo Switch',getGamepads:()=>[{buttons:Array.from({length:16},(_,i)=>({pressed:i===1&&state.pressA===true,value:0})),axes:[0,0,0,0]}]},
   console:{log(){},warn(){},error(){},debug(){},trace(){},info(){}},fonts:{add(){},delete(){},[Symbol.iterator]:[][Symbol.iterator]},
   setTimeout:timeout,clearTimeout:clear,setInterval:interval,clearInterval:clear,
   requestAnimationFrame(cb){const i=++id;raf.set(i,cb);return i;},cancelAnimationFrame(i){raf.delete(i);},
   performance,TextEncoder,TextDecoder,URL,URLSearchParams,Blob,Response,Request,Headers,fetch,atob,btoa,crypto:webcrypto,DOMException,
   ArrayBuffer,Uint8Array,Uint16Array,Uint32Array,Int8Array,Uint8ClampedArray,Float32Array,Float64Array,DataView,
   $:api,getSharedAudioContext:()=>sink,ctxInternal:c=>({handle:c}),nodeInternal:n=>({handle:n})};
 const cx=vm.createContext(globals);vm.runInContext('globalThis.window=globalThis;globalThis.self=globalThis;',cx);
 const header='var __name=(x,n)=>Object.defineProperty(x,"name",{value:n,configurable:true}); var init_xterm_process_shim=()=>{};';
 // No modifications or transpilation of the shipped event or movie modules.
 vm.runInContext(header+'\n'+pkg.utils+'\n'+pkg.eventCode+'\n'+(separate?pkg.audioCode+'\n':'')+pkg.movieCode,cx,{filename:'nxjs-shipped-events-and-video.js'});
 vm.runInContext('globalThis.addEventListener=EventTarget.prototype.addEventListener.bind(globalThis);globalThis.removeEventListener=EventTarget.prototype.removeEventListener.bind(globalThis);globalThis.dispatchEvent=EventTarget.prototype.dispatchEvent.bind(globalThis);',cx);
 if(!vm.SourceTextModule)throw Error('Use node --experimental-vm-modules');
 const app=new vm.SourceTextModule(pkg.app,{context:cx,identifier:'romfs:/main.js'});await app.link(()=>{throw Error('Unexpected external app import');});await app.evaluate();
 let observed; const buttonStep=[];
 return {W,H,screen,cx,state,movies,live,sidecarStats:()=>separate?.stats(),
   observe(){const v=cx.document?.getElementById?.('GameVideo');if(v&&v!==observed){observed=v;for(const tp of ['loadstart','loadedmetadata','loadeddata','play','ended','error'])v.addEventListener(tp,()=>{state.events.push({file:v.src.split('/').pop(),type:tp,ms:state.t,error:tp==='error'?v.error?.message:undefined});});}return observed;},
   pumpFrames(){const f=[...raf.entries()];for(const [k] of f)raf.delete(k);for(const [,cb] of f)cb(performance.now());},
   pumpAudio(frames){const out=Buffer.alloc(frames*4);for(const rec of live){const p=update(rec,frames);if(p?.length){for(let off=0;off<out.length;off+=2){const s=out.readInt16LE(off)+p.readInt16LE(off);out.writeInt16LE(Math.min(32767,Math.max(-32768,s)),off);}}}separate?.mix(out,frames);return out;},
   close(){separate?.close();try{cx.dispatchEvent(new cx.Event('unload'));}catch{}for(const r of live)api.videoClose(r.obj);for(const k of [...timers.keys()])clear(k);raf.clear();}
 };
}
