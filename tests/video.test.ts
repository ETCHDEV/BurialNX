import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserHost } from '../src/browser-host';
import { createMovieLayer, movieCanPlayType, audioCanPlayType } from '../src/video-element';
import { createMovieResolver, createAudioResolver, type MovieResolver } from '../src/video-source';

class N extends EventTarget { style:Record<string,string>={}; attributes:Record<string,string>={}; parentNode:any=null; constructor(public tagName='') {super();} }
class Native extends EventTarget {
        static instances:Native[]=[]; private url=''; requests=0; paused=true; ended=false; readyState=0; videoWidth=320; videoHeight=180; duration=1; volume=1; muted=false; loop=false; currentTime=0; closed=false;
        constructor(){super(); Native.instances.push(this);}
        set src(s:string){this.url=s;this.requests++;} get src(){return this.url;}
        async play(){this.paused=false; this.ended=false; this.dispatchEvent(new Event('play'));}
        pause(){this.paused=true; this.dispatchEvent(new Event('pause'));}
        close(){this.closed=true;}
        send(name:string){if(name==='loadedmetadata')this.readyState=1; if(name.startsWith('canplay'))this.readyState=4; if(name==='ended'){this.ended=true;this.paused=true;} this.dispatchEvent(new Event(name));}
}
const soon=()=>new Promise<void>(r=>setImmediate(r));
function setup(resolve:MovieResolver=async src=>({url:src,release(){}}),ctor:any=Native){
        const body=new N('BODY'), messages:string[]=[]; const layer=createMovieLayer(N,resolve,ctor,s=>messages.push(s),()=>body); const v:any=new layer.MovieNode();v.parentNode=body;return{layer,v,body,messages};
}
function ctx(){const draws:any[]=[];return{draws,save(){},restore(){},setTransform(){},fillRect(){},drawImage(...v:any[]){draws.push(v);}};}
const latest=()=>Native.instances.at(-1)!;

test('MV src -> assign handlers -> load: one decode, first frame then play, visible output, end returns control',async()=>{
        const {v,layer}=setup();let done=0, listener=0; let waiting=true;v.style.opacity=0;v.src='movies/demo.webm';
        v.onloadeddata=function(e:Event){assert.equal(e.target,v);v.play();v.style.opacity=1;waiting=false;done++;};v.addEventListener('loadeddata',()=>listener++);
        v.onended=()=>{v.style.opacity=0;};v.load();await soon();const n=latest();assert.equal(n.requests,1);n.send('loadedmetadata');assert.equal(waiting,true);
        n.send('canplay');n.send('canplaythrough');n.send('loadeddata');await soon();assert.equal(done,1);assert.equal(listener,1);assert.equal(n.paused,false);
        const c=ctx();assert.equal(layer.paint(c,0,0,400,400),true);assert.deepEqual(c.draws[0],[n,0,87.5,400,225]);n.send('ended');assert.equal(waiting||v.style.opacity>0,false);assert.equal(layer.paint(c,0,0,400,400),false);layer.dispose();assert.ok(n.closed);
});
test('video still draws when paused, never when hidden or detached; canvas can use native frame',async()=>{
        const {v,layer,body}=setup();v.src='test';await soon();const n=latest();n.send('canplay');assert.equal(v.drawable(),n);assert.equal(layer.visible(),true);v.style.display='none';assert.equal(layer.visible(),false);delete v.style.display;v.hidden=true;assert.equal(layer.visible(),false);v.hidden=false;v.parentNode=null;assert.equal(layer.visible(),false);v.parentNode=body;v.pause();assert.equal(layer.visible(),true); layer.dispose();
});
test('only advertise known movie MIME and codec combinations; no native decoder means no support',()=>{
        assert.equal(movieCanPlayType('video/webm',true),'maybe');assert.equal(movieCanPlayType('video/webm; codecs="vp8, opus"',true),'probably');
        assert.equal(movieCanPlayType('video/mp4; codecs="avc1.42001E, mp4a.40.2"',true),'probably');assert.equal(movieCanPlayType('video/webm; codecs="magical"',true),'');assert.equal(movieCanPlayType('text/html',true),'');assert.equal(movieCanPlayType('video/mp4',false),'');
});
test('source replacement and teardown revoke stale resources and ignore retired decoder events',async()=>{
        let releaseA=0, releaseB=0, late=0;let resolveA!:Function;const {v,layer}=setup(src=>src==='A'?new Promise(r=>resolveA=r):Promise.resolve({url:src,release(){releaseB++;}}));
        v.src='A';await soon();const p=v.play();v.src='B';resolveA({url:'old',release(){releaseA++;}});assert.equal((await p.catch(e=>e)).name,'AbortError');await soon();assert.equal(releaseA,1);const n=latest();v.onended=()=>late++;layer.dispose();n.send('ended');assert.equal(late,0);assert.equal(releaseB,1);assert.equal(n.closed,true);
});
test('real source failure is signalled once and retry via the MV property callback is possible',async()=>{
        let failOnce=true;const {v,layer}=setup(async src=>{if(failOnce){failOnce=false;throw new Error('missing movie');}return{url:src,release(){}};});let errors=0;v.onerror=()=>errors++;v.src='movies/A.mp4';v.load();await soon();assert.equal(errors,1);assert.match(v.error.message,/missing/);await assert.rejects(v.play(),/missing/);v.load();await soon();assert.equal(v.error,null);const n=latest();n.send('canplay');await v.play();assert.equal(n.paused,false);n.send('error');n.send('error');assert.equal(errors,2);layer.dispose();
});
test('volume, mute, loop and seek survive initialization; pause cancels queued play',async()=>{
        const {v,layer}=setup();v.volume=0.4;v.muted=true;v.loop=true;v.src='clip';v.currentTime=0.5;const cancelled=v.play();v.pause();await assert.rejects(cancelled,{name:'AbortError'});await soon();const n=latest();n.send('loadedmetadata');assert.equal(n.currentTime,0.5);assert.equal(n.volume,.4);assert.equal(n.muted,true);assert.equal(n.loop,true);await v.play();v.pause();assert.equal(v.paused,true);v.volume=.7;v.muted=false;v.loop=false;assert.equal(n.volume,.7);assert.equal(n.muted,false);assert.equal(n.loop,false);layer.dispose();
});
test('missing native decoder: asynchronous onerror, never synthetic success',async()=>{
        const {v,layer}=setup(undefined,null);let failed=0,ready=0;v.src='test.mp4';v.onerror=()=>failed++;v.onloadeddata=()=>ready++;v.load();await soon();assert.equal(failed,1);assert.equal(ready,0);assert.equal(v.canPlayType('video/mp4'),'');layer.dispose();
});
test('beta.7 private native unload closure is scoped, called once, unrelated unload listener never runs',async()=>{
        const g=globalThis as any,target=new EventTarget(),oldAdd=g.addEventListener,oldRemove=g.removeEventListener;g.addEventListener=target.addEventListener.bind(target);g.removeEventListener=target.removeEventListener.bind(target);let native=0,other=0;g.addEventListener('unload',()=>other++);
        class Upstream extends Native{constructor(){super();g.addEventListener('unload',()=>native++);}}
        Object.defineProperty(Upstream.prototype,'close',{value:undefined});
        try{const{v,layer}=setup(undefined,Upstream);v.src='clip';await soon();layer.dispose();layer.dispose();assert.equal(native,1);assert.equal(other,0);target.dispatchEvent(new Event('unload'));assert.equal(native,1);assert.equal(other,1);}finally{if(oldAdd)g.addEventListener=oldAdd;else delete g.addEventListener;if(oldRemove)g.removeEventListener=oldRemove;else delete g.removeEventListener;}
});
test('plain mod movie streams ahead of the base, reads only its header, handles spaces',async()=>{
        const hits:string[]=[];let full=0;const fs={statSync(path:string){return path==='sdmc:/mod/movies/A B.webm'?{mode:0o100644,size:200_000_000}:null;},async readFile(path:string,opt:any){hits.push(path);assert.ok(opt.end<=7);return new Uint8Array([26,69,223,163]).buffer;}};
        const resolve=createMovieResolver({async read(){full++;return null;}},['sdmc:/mod','sdmc:/game'],fs);const s=await resolve('./movies/A%20B.webm?rev=2');assert.equal(s.url,'sdmc:/mod/movies/A%20B.webm');assert.equal(full,0);assert.equal(hits.length,1);s.release();
});
test('wrapped mod movie uses the normal game reader and revocable blob, never falls back to a plain base',async()=>{
        let read=0;const fs={statSync(){return{mode:0o100644,size:20};},async readFile(){return new TextEncoder().encode('TCOAAL\u0001').buffer;}};
        const r=createMovieResolver({async read(p){read++;assert.equal(p,'movies/a.mp4');return new Uint8Array([5,4,3,2]).buffer;}},['sdmc:/mod','sdmc:/game'],fs);
        const s=await r('movies/a.mp4');assert.equal(read,1);assert.ok(s.url.startsWith('blob:'));assert.deepEqual([...new Uint8Array(await (await fetch(s.url)).arrayBuffer())],[5,4,3,2]);s.release();s.release();await assert.rejects(fetch(s.url));
});
test('resolver refuses arbitrary URLs and traversal; a missing asset never becomes playable',async()=>{
        const r=createMovieResolver({async read(){return null;}});for(const p of ['https://x.invalid/file','file:/a','sdmc:/outside.mp4','../a','movies/%2e%2e/a','//outside/clip','game://other/path']) await assert.rejects(r(p));await assert.rejects(r('movies/absent.mp4'),/missing/);
});

test('a single captured frame can start a short movie without a two-frame canplay notification',async()=>{
        class Short extends Native { getVideoPlaybackQuality(){return {totalVideoFrames:1,droppedVideoFrames:0};} }
        const {v,layer}=setup(undefined,Short);let data=0,playing=0;v.onloadeddata=()=>{data++;v.play();};v.onplaying=()=>playing++;v.src='short.mp4';await soon();const n=latest();n.send('loadedmetadata');await new Promise<void>(r=>setTimeout(r,90));n.send('playing');assert.equal(data,1);assert.equal(playing,1);assert.equal(v.readyState,v.HAVE_CURRENT_DATA);v.pause();await v.play();assert.equal(playing,2);layer.dispose();
});
test('an audio-only file presented as a movie fails promptly and does not hang MV',async()=>{
        const {v,layer}=setup();v.src='wrong.mp4';await soon();const n=latest();n.videoWidth=0;n.videoHeight=0;n.send('loadedmetadata');assert.match(v.error.message,/no decodable video track/);assert.equal(v.drawable(),undefined);layer.dispose();
});
test('a same-name MP4-only mod overrides the base WebM selected by the MV MIME probe',async()=>{
        const fs={statSync(p:string){return ['sdmc:/mod/movies/scene.mp4','sdmc:/game/movies/scene.webm'].includes(p)?{mode:0o100644,size:99}:null;},async readFile(){return new Uint8Array([0,0,0,20]).buffer;}};
        const r=createMovieResolver({async read(){throw Error('expected direct streaming');}},['sdmc:/mod','sdmc:/game'],fs);assert.equal((await r('movies/scene.webm')).url,'sdmc:/mod/movies/scene.mp4');
});
test('oversize packed movie is refused BEFORE a full read, without falling through to the base',async()=>{
        let calls=0;const r=createMovieResolver({async read(){calls++;return null;}},['sdmc:/mod','sdmc:/game'],{statSync(){return{mode:0o100644,size:70*1024*1024};},async readFile(){return new TextEncoder().encode('TCOAAL\x00').buffer;}});await assert.rejects(r('movies/intro.mp4'),/64 MiB/);assert.equal(calls,0);
});
for(const direct of [true,false])test(`actual BrowserHost (${direct?'direct':'offscreen'} canvas): movie last, even without a game redraw; post-ended scene restored`,async()=>{
        const g=globalThis as any,names=['screen','Video','OffscreenCanvas','document','XMLHttpRequest','HTMLElement','HTMLCanvasElement','HTMLVideoElement','HTMLSourceElement','HTMLAudioElement','Audio','location','innerWidth','innerHeight','devicePixelRatio','fetch','Image','moveBy','moveTo','resizeBy','resizeTo','focus','blur','close'];
        const old=names.map(k=>Object.getOwnPropertyDescriptor(g,k));const out:any[]=[];const per=(n:string)=>({canvas:null,save(){},restore(){},setTransform(){},fillRect(){},drawImage(...a:any[]){out.push([n,...a]);}});
        const screen={width:640,height:360,getContext:()=>sc};const sc=per('screen');class Off {context=per('off');constructor(public width:number,public height:number){}getContext(){return this.context;}}
        let host:any;
        try {
                g.Video=Native;g.screen=screen;g.OffscreenCanvas=Off;
                host=createBrowserHost({async read(){return null;}},(p,s)=>s,()=>{},false,direct,undefined,async path=>({url:path,release(){}}));
                const gc=g.document.createElement('canvas');gc.id='GameCanvas';gc.width=640;gc.height=360;g.document.body.appendChild(gc);assert.equal(host.direct(),direct);
                const video=g.document.createElement('video');assert.ok(video instanceof g.HTMLVideoElement);g.document.body.appendChild(video);video.src='movies/cg.mp4';await soon();const n=latest();n.send('canplay');await video.play();assert.ok(host.needsMoviePresent());host.present();assert.equal(out.at(-1)[0],'screen');assert.equal(out.at(-1)[1],n);
                const bitmap=g.document.createElement('canvas');bitmap.getContext('2d').drawImage(video,10,15);assert.equal(out.at(-1)[1],n);
                n.send('ended');video.style.opacity=0;assert.ok(host.needsMoviePresent(),'one more frame is needed to restore the game');host.present();assert.equal(host.needsMoviePresent(),false);assert.notEqual(out.at(-1)[1],n);
                assert.equal(host.hasUnpresentedGameFrame(),false);
                // A later game rAF changes the first scene after ended. The previous
                // overlay-clear alone is not evidence that this scene reached screen.
                gc.getContext('2d').fillRect(0,0,60,40);
                assert.equal(host.hasUnpresentedGameFrame(),!direct);
                if(host.hasUnpresentedGameFrame())host.present();
                assert.equal(host.hasUnpresentedGameFrame(),false);
                host.dispose();assert.equal(n.closed,true);
        } finally {host?.dispose();names.forEach((k,i)=>{if(old[i]) Object.defineProperty(g,k,old[i]!); else delete g[k];});}
});

test('loader menu pauses an active movie; loading while menu is open waits; user pause never auto-resumes',async()=>{
        const {v,layer}=setup();v.src='scene';await soon();let n=latest();n.send('canplay');await v.play();layer.setSuspended(true);assert.ok(n.paused);layer.setSuspended(false);await soon();assert.equal(n.paused,false);
        layer.setSuspended(true);v.pause();layer.setSuspended(false);await soon();assert.ok(n.paused);
        layer.setSuspended(true);v.src='next';await soon();n=latest();n.send('canplay');let played=false;const p=v.play().then(()=>{played=true;});await soon();assert.equal(played,false);assert.equal(n.paused,true);layer.setSuspended(false);await p;assert.equal(n.paused,false);
        layer.setSuspended(true);const stopped=v.play();await soon();layer.dispose();await assert.rejects(stopped,{name:'AbortError'});
});

// Detached <video><source> is how MV's unmodified PixiJS loads a video texture.
class Candidate extends EventTarget { tagName='SOURCE'; constructor(public src:string,public type=''){super();} }
function addSource(v:any,src:string,type=''){const el=new Candidate(src,type);(v.children??=[]).push(el);v.sourcesChanged();return el;}
test('source children: MIME filtering, explicit selection order, corrupted native open, one winning frame and one play',async()=>{
        const tried:any[]=[], released:string[]=[];
        const {v,layer}=setup(async (url,exact,mime)=>{tried.push([url,exact,mime]);if(url==='missing')throw Error('absent');return{url,release(){released.push(url);}};});
        v.parentNode=null;let childErrors=0, videoErrors=0, data=0;
        addSource(v,'not-allowed','text/html');for(const n of ['missing','broken','right'])addSource(v,n,'video/mp4').addEventListener('error',()=>childErrors++);
        v.onerror=()=>videoErrors++;v.onloadeddata=()=>data++;v.load();const queued=v.play();await soon();const broken=latest();assert.equal(broken.src,'broken');broken.send('error');await soon();const right=latest();assert.notEqual(right,broken);assert(broken.closed);assert.equal(v.currentSrc,'right');assert.equal(v.src,'');assert.equal(right.paused,true);right.send('canplay');await queued;right.send('canplaythrough');assert.equal(data,1);assert.equal(videoErrors,0);assert.equal(childErrors,2);assert.equal(right.paused,false);assert.equal(layer.visible(),false);assert.equal(v.drawable(),right);assert.deepEqual(tried,[['missing',true,'video/mp4'],['broken',true,'video/mp4'],['right',true,'video/mp4']]);layer.dispose();assert.deepEqual(released,['broken','right']);
});
test('a plugin may append only (no load), and attach handlers after building its node',async()=>{
        const {v,layer}=setup();addSource(v,'movie.webm?rev=2','video/webm?rev=2');let n=0;v.oncanplay=()=>n++;await soon();const p=latest();assert.equal(p.requests,1);p.send('canplay');p.send('canplay');assert.equal(n,1);assert.equal(v.currentSrc,'movie.webm?rev=2');layer.dispose();
});
test('an early play is cancelled on src replacement; old decode events and candidates never run',async()=>{
        const {v,layer}=setup();const a=addSource(v,'one','video/mp4');let errors=0;a.addEventListener('error',()=>errors++);addSource(v,'should-skip','video/mp4');v.load();const old=v.play();await soon();const n=latest();v.src='chosen.mp4';await assert.rejects(old,{name:'AbortError'});await soon();n.send('error');assert(n.closed);assert.equal(errors,0);assert.equal(v.currentSrc,'chosen.mp4');assert.equal(latest().src,'chosen.mp4');layer.dispose();
});
test('direct src wins; explicitly empty src stops; removing src enables source list without using the old file',async()=>{
        const tried:string[]=[];const {v,layer}=setup(async url=>{tried.push(url);return{url,release(){}};});addSource(v,'child','video/webm');v.src='preferred';v.load();await soon();assert.deepEqual(tried,['preferred']);v.src='';v.load();await soon();assert.deepEqual(tried,['preferred']);assert.equal(v.drawable(),undefined);v.removeAttribute('src');await soon();assert.deepEqual(tried,['preferred','child']);assert.equal(v.src,'');assert.equal(v.currentSrc,'child');layer.dispose();
});
test('if every candidate is rejected, child errors precede one terminal media error; a new appended source can recover',async()=>{
        const {v,layer}=setup(async url=>{if(!url.endsWith('ok'))throw Error('no source');return{url,release(){}};});const seen:string[]=[];for(const n of ['a','b'])addSource(v,n,'video/mp4').addEventListener('error',()=>seen.push(n));v.onerror=()=>seen.push('video');const p=v.play();await assert.rejects(p,/no source/);assert.deepEqual(seen,['a','b','video']);v.children=[];addSource(v,'ok','video/webm');await soon();latest().send('canplay');assert.equal(v.error,null);assert.equal(v.currentSrc,'ok');layer.dispose();
});
test('a source error callback may remove the next candidate and append its replacement',async()=>{
        const tried:string[]=[];const {v,layer}=setup(async url=>{tried.push(url);if(url==='absent')throw Error('missing');return{url,release(){}};});const a=addSource(v,'absent','video/mp4'),b=addSource(v,'removed','video/mp4');a.addEventListener('error',()=>{v.children=v.children.filter((s:any)=>s!==b);addSource(v,'added','video/webm');});v.load();await soon();assert.deepEqual(tried,['absent','added']);latest().send('canplay');assert.equal(v.currentSrc,'added');layer.dispose();
});
test('one-frame child can wake Pixi canplay using actual presented frame statistics, not only metadata',async()=>{
        class Tiny extends Native {duration=.04;getVideoPlaybackQuality(){return{totalVideoFrames:1,droppedVideoFrames:0};}}
        const {v,layer}=setup(undefined,Tiny);let n=0;addSource(v,'one-frame','video/webm');v.oncanplay=()=>{n++;void v.play();};v.load();await soon();const p=latest();p.send('loadedmetadata');assert.equal(n,0);await new Promise(r=>setTimeout(r,100));assert.equal(n,1);assert(v.readyState>=3);assert(!v.paused);p.send('canplay');assert.equal(n,1);layer.dispose();
});
test('reject a one-frame false-positive from FFmpeg for a mislabeled source; an explicit list never reorders same-basename alternatives',async()=>{
        const reads:string[]=[];const enc=new TextEncoder();const bytes=new Map([['bad.webm',enc.encode('Intentionally not a media file.').buffer],['assets/only.mp4',new Uint8Array([0,0,0,8,102,116,121,112]).buffer]]);const r=createMovieResolver({async read(p){reads.push(p);return bytes.get(p)??null;}});
        await assert.rejects(r('bad.webm',true,'video/webm'),/WebM/);await assert.rejects(r('bad.webm',true,'video/mp4'),/ISO/);await assert.rejects(r('assets/only.webm',true,'video/webm'),/missing/);assert(!reads.includes('assets/only.mp4'));const ok=await r('assets/only.mp4',true,'video/mp4');assert(ok.url.startsWith('blob:'));ok.release();const direct=await r('assets/only.webm');direct.release();
});

// beta.7 native Audio only emits loadedmetadata/canplaythrough. Assertions here cover
// DOM semantics; the separate packed-NRO integration checks real pixels and stereo PCM.
class VoiceBackend extends Native {
        videoWidth=0;videoHeight=0;starts=0;playbackRate=1;
        override async play(){this.starts++;this.paused=false;this.ended=false;this.dispatchEvent(new Event('play'));}
}
function voiceSetup(resolve:MovieResolver=async path=>({url:path,release(){}})){
        const layer=createMovieLayer(N,resolve,VoiceBackend,()=>{},()=>null,true);
        return {layer,a:new layer.MovieNode() as any};
}
const voice=()=>latest() as VoiceBackend;
test('separate audio: eager play waits for FFmpeg completion, emits ready/playing once, never draws an overlay',async()=>{
        const freed:string[]=[],events:string[]=[];const{a,layer}=voiceSetup(async path=>({url:path,release(){freed.push(path);}}));a.src='audio/voice.ogg';a.load();for(const n of ['loadedmetadata','loadeddata','canplay','canplaythrough','playing','ended'])a.addEventListener(n,()=>events.push(n));const p=a.play();await soon();const b=voice();assert.equal(a.tagName,'AUDIO');assert.equal(b.requests,1);assert.equal(b.starts,0);b.send('loadedmetadata');assert.deepEqual(events,['loadedmetadata']);b.send('canplaythrough');await p;assert.deepEqual(events,['loadedmetadata','loadeddata','canplay','canplaythrough','playing']);assert.deepEqual(freed,['audio/voice.ogg']);assert.equal(a.drawable(),undefined);assert.equal(layer.visible(),false);await a.play();assert.equal(b.starts,1);b.currentTime=b.duration;b.send('ended');assert.equal(a.ended,true);await a.play();assert.equal(b.currentTime,0);assert.equal(b.starts,2);layer.dispose();assert.equal(freed.length,1);assert(b.closed);
});
test('separate audio: mute is native gain, unmute restores requested volume; transport survives reload and host pause',async()=>{
        const{a,layer}=voiceSetup();a.playbackRate=1.5;a.volume=.6;a.muted=true;a.loop=true;a.src='a';a.currentTime=.25;await soon();const b=voice();assert.equal(b.volume,0);assert.equal(b.loop,true);assert.equal(b.playbackRate,1.5);b.send('loadedmetadata');assert.equal(b.currentTime,.25);b.send('canplaythrough');await a.play();a.volume=.38;assert.equal(b.volume,0);a.muted=false;assert.equal(b.volume,.38);layer.setSuspended(true);assert.ok(b.paused);layer.setSuspended(false);await soon();assert.equal(b.paused,false);layer.setSuspended(true);a.pause();layer.setSuspended(false);await soon();assert.ok(b.paused);assert.throws(()=>{a.playbackRate=0;});layer.dispose();
});
test('separate audio: pause immediately cancels play before decode completion; no stale source starts or events',async()=>{
        const{a,layer}=voiceSetup();a.src='old';const p=a.play();await soon();const n=voice();a.pause();await assert.rejects(p,{name:'AbortError'});let ends=0;a.onended=()=>ends++;a.src='next';await soon();const b=voice();n.send('ended');n.send('canplaythrough');assert.equal(ends,0);assert.equal(n.starts,0);const q=a.play();layer.dispose();await assert.rejects(q,{name:'AbortError'});assert.equal(b.starts,0);assert.ok(b.closed);
});
test('separate audio: typed children select only playable audio, discard a failed decode and release every Blob exactly once',async()=>{
        const order:string[]=[],free:string[]=[];const{a,layer}=voiceSetup(async (p,exact)=>{assert(exact);order.push(p);return{url:p,release(){free.push(p);}};});addSource(a,'skip','video/mp4');const bad=addSource(a,'bad','audio/ogg');addSource(a,'ok','audio/ogg');let e=0;bad.addEventListener('error',()=>e++);const early=a.play();await soon();const one=voice();one.send('error');await soon();assert(one.closed);assert.equal(e,1);const two=voice();two.send('loadedmetadata');two.send('canplaythrough');await early;assert.equal(a.currentSrc,'ok');assert.deepEqual(order,['bad','ok']);assert.deepEqual(free,['bad','ok']);assert.equal(a.error,null);layer.dispose();
});
test('separate audio: unsupported mime, nonexistent file, or all candidates failing never produce fake readiness',async()=>{
        assert.equal(audioCanPlayType('audio/ogg; codecs="opus"',true),'probably');assert.equal(audioCanPlayType('audio/x-m4a',true),'maybe');assert.equal(audioCanPlayType('video/ogg',true),'');assert.equal(audioCanPlayType('audio/ogg; codecs="vp9"',true),'');assert.equal(audioCanPlayType('audio/flac',false),'');const{a,layer}=voiceSetup(async()=>{throw Error('file not found');});let e=0,ready=0;a.onerror=()=>e++;a.onloadeddata=()=>ready++;a.src='no.ogg';await assert.rejects(a.play(),/file not found/);assert.equal(e,1);assert.equal(ready,0);layer.dispose();
});
test('audio resolver gives the native fetch bridge a revocable local Blob, not a raw SD URL or an arbitrary network URL',async()=>{
        const bytes=new TextEncoder().encode('OggSfixture').buffer;const reads:string[]=[];let full=0;const fs={statSync(p:string){return p==='sdmc:/mod/audio/q.ogg'?{mode:0o100644,size:11}:null;},async readFile(p:string,opts:any){assert(opts.end<=8);reads.push(p);return bytes;}};
        const resolve=createAudioResolver({async read(p){full++;assert.equal(p,'audio/q.ogg');return bytes;}},['sdmc:/mod','sdmc:/game'],fs);const r=await resolve('audio/q.ogg',true,'audio/ogg');assert(r.url.startsWith('blob:'));assert.equal(full,1);assert.equal(reads[0],'sdmc:/mod/audio/q.ogg');assert.deepEqual(new Uint8Array(await (await fetch(r.url)).arrayBuffer()),new Uint8Array(bytes));r.release();await assert.rejects(fetch(r.url));await assert.rejects(resolve('https://invalid.example/voice.ogg'));await assert.rejects(resolve('../a.ogg'));
});
test('separate audio: reject a large known regular file before full read, without affecting movie streaming',async()=>{
        let full=0;const fs={statSync(){return{mode:0o100644,size:70*1024*1024};},async readFile(){return new TextEncoder().encode('OggSdata').buffer;}};const reader={async read(){full++;return null;}};await assert.rejects(createAudioResolver(reader,['sdmc:/game'],fs)('a.ogg',true,'audio/ogg'),/64 MiB/);assert.equal(full,0);
});
