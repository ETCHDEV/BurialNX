// Decode the DELIVERED recording again, without reading the harness report or
// original fixtures. Count visually white pulses and actual stereo audio onsets.
import {execFileSync as ex} from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const [file,report,kind='fullscreen']=process.argv.slice(2);if(!file||!['fullscreen','sprite'].includes(kind))throw Error('usage: node inspect-capture.mjs output.mp4 [report.json] [fullscreen|sprite]');
const streams=JSON.parse(ex('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file])).streams;
const v=streams.find(s=>s.codec_type==='video'),a=streams.find(s=>s.codec_type==='audio');assert(v&&a&&a.channels===2);
const fps=v.avg_frame_rate.split('/').map(Number).reduce((x,y)=>x/y);const [w,h]=[48,28];
const decode=args=>ex('ffmpeg',['-v','error','-nostdin','-i',file,...args,'pipe:1'],{maxBuffer:60*1024*1024});
const roi=kind==='sprite'?'crop=iw/8:ih/6:7*iw/16:5*ih/12':'crop=iw/2:ih/3:iw/4:ih/3';
const pix=decode(['-map','0:v:0','-vf',`${roi},scale=${w}:${h}`,'-pix_fmt','rgb24','-f','rawvideo']);
const pcm=decode(['-map','0:a:0','-ar','48000','-ac','2','-f','s16le']);
const white=[],tone=[],peak=[0,0];let was=false;const hashes=new Set();
for(let i=0,n=w*h*3;i+n<=pix.length;i+=n){const p=pix.subarray(i,i+n),avg=p.reduce((s,x)=>s+x,0)/n,on=avg>235;if(on&&!was)white.push(Math.round((i/n/fps+Number(v.start_time||0))*1000));was=on;hashes.add(createHash('sha256').update(p).digest('hex'));}
was=false;for(let i=0,n=480*4;i+n<=pcm.length;i+=n){let l=0,r=0;for(let j=i;j<i+n;j+=4){l+=(pcm.readInt16LE(j)/32768)**2;r+=(pcm.readInt16LE(j+2)/32768)**2;}const left=Math.sqrt(l/480),right=Math.sqrt(r/480);peak[0]=Math.max(peak[0],left);peak[1]=Math.max(peak[1],right);const on=Math.max(left,right)>.03;if(on&&!was)tone.push(Math.round((i/4/48000+Number(a.start_time||0))*1000));was=on;}
const offsets=white.map((x,i)=>Math.abs(x-tone[i]));const result={scope:'Independent re-decode of the published desktop recording',containerSha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex'),video:v.codec_name,screen:[v.width,v.height],audio:a.codec_name,channels:a.channels,framesPerSecond:fps,movingSampleHashes:hashes.size,whiteOnsetsMs:white,toneOnsetsMs:tone,absOffsetsMs:offsets,peakStereoPCM_RMS:peak.map(x=>+x.toFixed(4))};
assert.equal(white.length,8,JSON.stringify(result));assert.equal(tone.length,8,JSON.stringify(result));assert(offsets.every(n=>n<=125),JSON.stringify(result));for(const z of [white,tone])for(const start of [0,4])for(let i=start+1;i<start+4;i++)assert(Math.abs(z[i]-z[i-1]-1000)<125,JSON.stringify(result));assert(hashes.size>85&&peak.every(n=>n>.055),JSON.stringify(result));
if(kind==='sprite'){
  // Validate a patch outside the sprite (but still inside the game) in the
  // SAME video frames as its eight flashes. A full-screen overlay cannot pass.
  const border=decode(['-map','0:v:0','-vf','crop=iw/32:ih/20:iw/4:ih/4,scale=4:4','-pix_fmt','rgb24','-f','rawvideo']);
  const at=ms=>{let i=Math.max(0,Math.round((ms/1000-Number(v.start_time||0))*fps))*48;let s=[0,0,0];for(let k=0;k<48;k++)s[k%3]+=border[i+k];return s.map(x=>Math.round(x/16));};
  const bg=white.map(at);assert(bg.every(rgb=>[23,48,70].every((n,j)=>Math.abs(n-rgb[j])<=8)),JSON.stringify(bg));
  result.spriteOuterBackgroundAtFlashes=bg;
}
result.passed=true;if(report)fs.writeFileSync(report,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
