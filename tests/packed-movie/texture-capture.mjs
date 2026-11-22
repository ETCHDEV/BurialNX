// Record only final display readback and the mixed output bus. No source movie is
// given to the output encoder; captures are desktop evidence, not hardware footage.
import fs from 'node:fs';import path from 'node:path';import {spawn,execFileSync} from 'node:child_process';import {once} from 'node:events';import {createHash} from 'node:crypto';
export function captureScreen(dir,w,h){
  const pixels=path.join(dir,'picture.mp4'),sound=path.join(dir,'audio.pcm');let fd=fs.openSync(sound,'wx'),frames=0;
  const ff=spawn('ffmpeg',['-nostdin','-hide_banner','-v','error','-f','rawvideo','-pix_fmt','rgba','-s',`${w}x${h}`,'-framerate','24','-i','pipe:0','-an','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-preset','veryfast','-crf','17',pixels],{stdio:['pipe','ignore','inherit']});const ended=once(ff,'exit');
  return {async tick(screen,pcm,t){fs.writeSync(fd,pcm);while(frames<Math.floor(t*24/1000)+1){const a=screen.getContext('2d').getImageData(0,0,w,h).data;const ok=ff.stdin.write(Buffer.from(a.buffer,a.byteOffset,a.byteLength));frames++;if(!ok)await once(ff.stdin,'drain');}},
    async finish(target){ff.stdin.end();const [code]=await ended;if(code!==0)throw Error('Screen capture encoder failed: '+code);fs.closeSync(fd);fd=undefined;if(!target)return{};
      execFileSync('ffmpeg',['-nostdin','-v','error','-y','-i',pixels,'-f','s16le','-ar','48000','-ac','2','-i',sound,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','160k','-movflags','+faststart','-shortest','-metadata','comment=Desktop capture from BurialNX published JS and nx.js media core, not Nintendo Switch hardware.',target]);return {captureFrames:frames,captureSha256:createHash('sha256').update(fs.readFileSync(target)).digest('hex')};},
    close(){if(fd!==undefined){fs.closeSync(fd);fd=undefined;}if(ff.exitCode===null&&ff.signalCode===null){ff.stdin.destroy();ff.kill('SIGKILL');}}
  };
}
