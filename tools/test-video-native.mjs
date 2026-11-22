// NXJS_MEDIA_SOURCE is the source/ directory from TooTallNate/nx.js v1.0.0-beta.7 with the cg.5 audio-preroll + track-timeline patches.
// Use the exact same four files as the device runtime, without vendoring its code.
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const source=process.env.NXJS_MEDIA_SOURCE;
if (!source) throw new Error('Set NXJS_MEDIA_SOURCE to nx.js v1.0.0-beta.7/source with the cg.5 audio-preroll + track-timeline patches. Requires a C++17 compiler, pkg-config, and FFmpeg development libraries.');
const src=resolve(source),root=fileURLToPath(new URL('../',import.meta.url));
for(const [file,expected] of Object.entries({
  'media-decoder.cc':'ba3568226f639d12c0b820de662bcb8d09437438c8f11c5c4188c699d2761ced',
  'media-decoder.h':'2f9d816880b9ed51f101fa7fbc32bf4666ef434faecddc2d1306b59556ea9d22',
  'audio-graph.cc':'a1c56f338022d3a6ea93893555c29da9c92473e121007d53ce1734d803afbe96',
  'audio-graph.h':'f0ae69e9ef63357e520b7e9869097ecc5392121cb3ec32422dcf263008eb8c1c'
})){if(createHash('sha256').update(await readFile(join(src,file))).digest('hex')!==expected)throw new Error('Unexpected upstream source: '+file);}
const tmp=await mkdtemp(join(tmpdir(),'burialnx-native-probe-'));
try {
  const libs=execFileSync('pkg-config',['--cflags','--libs','libavcodec','libavformat','libswscale','libswresample','libavutil'],{encoding:'utf8'}).trim().split(/\s+/);
  const bin=join(tmp,'movie-probe');execFileSync(process.env.CXX||'c++',['-std=c++17','-O2','-pthread','-I',src,join(root,'tests/video-native-probe.cc'),join(src,'media-decoder.cc'),join(src,'audio-graph.cc'),...libs,'-o',bin],{stdio:'inherit'});
  const movies=join(root,'tests/fixtures/cg/www/movies');execFileSync(bin,[join(movies,'sync.mp4'),join(movies,'sync.webm')],{stdio:'inherit',timeout:22000});
} finally {await rm(tmp,{recursive:true,force:true});}
