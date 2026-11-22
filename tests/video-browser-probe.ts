// Desktop integration probe. The decoder and PCM samples here come from Chromium,
// NOT from Switch hardware. Everything between the MV callbacks and the decoder,
// including asset -> Blob and the actual movie layer drawing, is the production code.
import { createMovieLayer } from '../src/video-element';
import { createMovieResolver } from '../src/video-source';
class NodeLike extends EventTarget { style:Record<string,string>={}; attributes:Record<string,string>={}; parentNode:any; constructor(public tagName:string) { super(); } }
const assert=(ok:unknown,message:string)=>{if(!ok) throw new Error(message);};
(globalThis as any).runCgProbe=async function() {
        // A non-audible *desktop* sink measures real PCM without a physical speaker.
        const ac=new AudioContext({sinkId:{type:'none'}} as any); await ac.resume(); let meter!:AnalyserNode; let backend!:HTMLVideoElement;
        const canvas=document.createElement('canvas');canvas.width=384;canvas.height=288;document.body.appendChild(canvas);
        const ctx=canvas.getContext('2d',{willReadFrequently:true})!;
        class BrowserBackend {
                constructor(){
                        const v=document.createElement('video'); backend=v; v.playsInline=true; v.preload='auto';
                        v.style.cssText='position:fixed;left:0;bottom:0;width:64px;height:36px';document.body.appendChild(v);
                        const src=ac.createMediaElementSource(v), a=ac.createAnalyser();a.fftSize=1024;meter=a;src.connect(a);a.connect(ac.destination);
                        Object.defineProperty(v,'close',{value(){v.pause();v.removeAttribute('src');v.load();src.disconnect();a.disconnect();v.remove();}});
                        return v as any;
                }
        }
        const body=new NodeLike('BODY');
        const resolver=createMovieResolver({async read(path){const r=await fetch('/'+path);return r.ok?r.arrayBuffer():null;}});
        const messages:string[]=[];const layer=createMovieLayer(NodeLike,resolver,BrowserBackend as any,s=>messages.push(s),()=>body);
        const video:any=new layer.MovieNode(); video.parentNode=body; video.volume=1;
        const result=[];
        try {
                for(const file of ['sync.mp4','sync.webm']) {
                        const hashes=new Set<number>(), audioOnsets:number[]=[], flashOnsets:number[]=[];
                        let prevAudio=false,prevWhite=false,peak=0,frames=0,letterbox=false,ready=0,ends=0;
                        let raf=0;const samples=new Float32Array(1024);
                        video.style.opacity='0';
                        await new Promise<void>((done,fail)=>{
                                const timer=setTimeout(()=>fail(new Error(file+': timeout: '+JSON.stringify({log:messages,ready,ends,frames,s:backend?.readyState,network:backend?.networkState,t:backend?.currentTime,dur:backend?.duration,p:backend?.paused,active:ac.state,clock:ac.currentTime,visibility:document.visibilityState,src:backend?.currentSrc?.slice(0,10)}))),13000);
                                const finish=(e?:Error)=>{clearTimeout(timer);cancelAnimationFrame(raf);if(e)fail(e);else done();};
                                // Match the observable call order of MV's Graphics._playVideo.
                                video.src='movies/'+file;
                                video.onloadeddata=()=>{ready++;video.play().catch(finish);video.style.opacity='1';};
                                video.onerror=()=>finish(new Error(file+': '+JSON.stringify(video.error)));
                                video.onended=()=>{ends++;video.style.opacity='0';finish();};
                                video.load();
                                function tick(){
                                        if(layer.paint(ctx,0,0,384,288)){
                                                const time=video.currentTime;
                                                const img=ctx.getImageData(0,0,384,288).data;let hash=2166136261;let sum=0,n=0;
                                                for(let y=54;y<235;y+=22) for(let x=24;x<365;x+=35){const k=4*(y*384+x);sum+=img[k]+img[k+1]+img[k+2];n+=3;hash=Math.imul(hash^img[k],16777619);hash=Math.imul(hash^img[k+1],16777619);}
                                                hashes.add(hash);frames++;letterbox ||= img[3]===255 && img[0]<5 && img[1]<5 && img[2]<5;
                                                const white=sum/n>237;if(white&&!prevWhite)flashOnsets.push(time);prevWhite=white;
                                                meter.getFloatTimeDomainData(samples);let ss=0;for(const v of samples)ss+=v*v;const rms=Math.sqrt(ss/samples.length);peak=Math.max(peak,rms);
                                                const sounding=rms>.035;if(sounding&&!prevAudio)audioOnsets.push(time);prevAudio=sounding;
                                        }
                                        raf=requestAnimationFrame(tick);
                                }
                                raf=requestAnimationFrame(tick);
                        });
                        const offsets:number[]=[];
                        for(const n of [1,2,3]){
                                const nearest=(a:number[])=>a.reduce((b,v)=>Math.abs(v-n)<Math.abs(b-n)?v:b,99);
                                const a=nearest(audioOnsets),v=nearest(flashOnsets);assert(Math.abs(a-n)<.22 && Math.abs(v-n)<.22,`${file}: missing pulse ${n}; audio ${audioOnsets}, white ${flashOnsets}`);
                                offsets.push(Math.round(Math.abs(a-v)*1000));
                        }
                        assert(offsets.every(n=>n<=150),file+': desktop flash/audio offset exceeded 150 ms: '+offsets);
                        assert(ready===1 && ends===1 && !layer.visible(),file+': callbacks did not return MV to game');assert(hashes.size>=20&&frames>=30&&letterbox,file+': no properly letterboxed moving picture');assert(peak>.06,file+': decoded audio silent');
                        result.push({file,width:video.videoWidth,height:video.videoHeight,callbacks:{ready,ends},sampledFrames:frames,distinctFrames:hashes.size,peakPcmRms:+peak.toFixed(3),flashCount:flashOnsets.length,toneCount:audioOnsets.length,pulseOffsetsMs:offsets});
                }
                return result;
        } finally {layer.dispose();await ac.close();}
};
