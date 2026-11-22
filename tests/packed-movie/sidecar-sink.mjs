// Desktop QA platform adapter, not shipped in the loader. nx.js Audio JS comes
// straight from the NRO. FFmpeg decode and all digital signal processing/PCM,
// including gain, rate, source end and mixing, come from the real native core.
import {createRequire} from 'node:module';import path from 'node:path';
export function sidecarSink(sink,api,filename,expected){
  const n=createRequire(import.meta.url)(path.resolve(filename)),graph=n.graph(),sources=new Set();let fileDecodes=0;
  if(n.sourceSha256!==expected)throw Error('Separate audio QA core must match the released native decoder');
  api.audioDecode=b=>{fileDecodes++;return Promise.resolve(n.decode(new Uint8Array(b)));};
  Object.defineProperty(sink,'currentTime',{get:()=>n.time(graph)});
  const origGain=sink.createGain.bind(sink);
  sink.createGain=()=>{const g=origGain(),listeners=new Set(),param=g.gain,desc=Object.getOwnPropertyDescriptor(param,'value');
    Object.defineProperty(param,'value',{get(){return desc.get.call(param);},set(v){desc.set.call(param,v);for(const s of listeners)s.syncGain();}});g.voices=listeners;return g;};
  sink.createBufferSource=()=>{
    let h=null,g=null,repeat=false,speed=1,retired=false,ended=false;
    const release=()=>{if(retired)return;retired=true;if(h){n.release(h);h=null;}g?.voices.delete(s);sources.delete(s);};
    const s={buffer:null,onended:null,connect(dest){g=dest;g.voices.add(s);},disconnect:release,
      set loop(v){repeat=!!v;if(h)n.loop(h,repeat);},get loop(){return repeat;},
      playbackRate:{get value(){return speed;},set value(v){speed=v;if(h)n.rate(h,speed);}},
      syncGain(){if(h&&g)n.gain(h,process.env.CG_SIDECAR_MUTE==='1'?0:g.gain.value);},
      start(_when=0,offset=0){if(h||retired||!s.buffer||!g)throw Error('Invalid buffer source');h=n.voice(graph,s.buffer.channels,s.buffer.rate);s.syncGain();n.loop(h,repeat);n.rate(h,speed);n.start(h,offset);sources.add(s);},
      stop(){if(h)n.stop(h);},poll(){if(!retired&&!ended&&h&&n.finished(h)){ended=true;const cb=s.onended;release();if(cb)cb();}},release};return s;
  };
  return {globals:{AudioContext:function(){return sink;},createAudioBuffer:(channels,rate)=>({channels,rate,duration:channels[0].length/rate})},
    mix(out,frames){const pcm=n.render(graph,frames);if(pcm.length!==out.length)throw Error('PCM size mismatch');for(let i=0;i<out.length;i+=2)out.writeInt16LE(Math.max(-32768,Math.min(32767,out.readInt16LE(i)+pcm.readInt16LE(i))),i);for(const s of [...sources])s.poll();},
    close(){for(const s of [...sources])s.release();}, stats(){return {actualFFmpegAudioDecodes:fileDecodes,activeBufferSources:sources.size};}};
}
