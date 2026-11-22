// Read the actual card package; never rebuild the application for this integration check.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const deps=createRequire(process.env.CG_TEST_DEPS?join(resolve(process.env.CG_TEST_DEPS),'package.json'):import.meta.url);
const {decode:readNro}=await import(pathToFileURL(deps.resolve('@tootallnate/nro')).href);
const {decode:readRom}=await import(pathToFileURL(deps.resolve('@tootallnate/romfs')).href);
function section(s,first,last){const a=s.indexOf(first),b=s.indexOf(last,a);if(a<0||b<=a)throw Error('Missing packaged module boundary '+first);return s.slice(a,b+last.length);}
export async function packageInput(zip){
  const entry=name=>execFileSync('unzip',['-p',zip,name],{maxBuffer:100*1024*1024});
  const nro=entry('switch/burialnx/burialnx.nro'), obj=await readNro(new Blob([nro])), rom=await readRom(obj.romfs);
  const app=await rom['main.js'].text(), end=nro.readUInt32LE(24), native=nro.subarray(0,end);
  const marker=Buffer.from('//# sourceMappingURL=runtime.js.map');const stop=native.indexOf(marker);if(stop<0)throw Error('Missing runtime.js');
  const boot=native.subarray(native.lastIndexOf(0,stop)+1,stop+marker.length).toString('utf8');
  if(!boot.startsWith('"use strict";')||!['3fbafb0da26d7ba6e8a2c1be208d575559419b231365debda5046a81ed8df1a6','b3f8593f44e22d0281d94c7a51bbfe96072f48ab1ee81eb7efa2998f84ffdbf4','d19416181cc10974ac8b44f902fb0232f032f78e38021f7dbce1dcc3c2834cb6'].includes(sha(native)))throw Error('Unexpected device executable; re-review the host binding adapter.');
  const eventCode=section(boot,'  // src/polyfills/event-target.ts\n','  def(EventTarget);');
  const audioCode=section(boot,'  // src/audio.ts\n','  def(Audio);');
  const movieCode=section(boot,'  // src/video.ts\n','  def(Video);');
  const utils=[section(boot,'  var proto =','}, "def");'),section(boot,'  var createInternal =','}, "createInternal");')].join('\n');
  const files=new Map(), fixtureDigests={};
  for(const p of ['index.html','js/rpg_core.js','movies/sync.mp4','movies/sync.webm']){
    const b=entry('BurialNX-CG-check/www/'+p);files.set('sdmc:/BurialNX-CG-check/www/'+p,b);fixtureDigests[p]=sha(b);
  }
  return {app,utils,eventCode,movieCode,audioCode,files,provenance:{nroSha256:sha(nro),armExecutableSha256:sha(native),romfsMainJsSha256:sha(app),runtimeVideoJsSha256:sha(movieCode),runtimeAudioJsSha256:sha(audioCode),runtimeEventsJsSha256:sha(eventCode),fixtureSha256:fixtureDigests}};
}
