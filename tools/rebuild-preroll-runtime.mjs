// Offline Switch cross-build, including preroll and track-timeline patches. Supply a clean upstream checkout/archive and a NEW,
// disposable build directory (no modifications to upstream or the system SDK).
// npm ci in this project supplies the pinned vendor NRO used ONLY for unchanged
// runtime.js, runtime.js.map and font data. The ARM machine code is entirely linked by make.
import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';import {execFileSync as cmd} from 'node:child_process';import {gzipSync} from 'node:zlib';
import {decode as nroDecode} from '@tootallnate/nro';import {decode as romDecode} from '@tootallnate/romfs';import {pinnedCode} from './check-video-runtime.mjs';
const [up,out]=process.argv.slice(2);if(!up||!out||!process.env.DEVKITPRO)throw Error('Set DEVKITPRO and pass: clean-nxjs-v1.0.0-beta.7-checkout /new/build/directory');
const root=fileURLToPath(new URL('../',import.meta.url)),src=fs.realpathSync(up),work=path.resolve(out),sdk=fs.realpathSync(process.env.DEVKITPRO);
if(work===src || work.startsWith(src+path.sep) || src.startsWith(work+path.sep) || fs.existsSync(work))throw Error('Build directory must be new and outside upstream checkout');
if([work,sdk].some(v=>/\s/.test(v)))throw Error('The devkitPro Makefiles need paths without spaces');
const hash=b=>createHash('sha256').update(b).digest('hex');const initial=fs.readFileSync(path.join(src,'source/media-decoder.cc'));
if(hash(initial)!=='63f1fc541f57dc44b802e99744e2e0f824d9f99668cc6c8402c529c13a5a2327')throw Error('Expected unmodified nx.js v1.0.0-beta.7 (a649611a1a4daca09924cd1a436c7ca786f91592)');
if(fs.existsSync(path.join(src,'.git'))){const head=cmd('git',['-C',src,'rev-parse','HEAD'],{encoding:'utf8'}).trim();if(head!=='a649611a1a4daca09924cd1a436c7ca786f91592')throw Error('Incorrect upstream git revision');}
fs.mkdirSync(work,{recursive:true});const cp=(p)=>{const dest=path.join(work,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.cpSync(path.join(src,p),dest,{recursive:true});};
for(const p of ['source','Makefile','tools/embed-runtime.mjs','packages/runtime/package.json','icon.jpg','npdm.json','include','data','exefs_src'])if(fs.existsSync(path.join(src,p)))cp(p);
cmd('patch',['-p1','-i',path.join(root,'patches/nxjs-video-audio-preroll.patch')],{cwd:work,stdio:'inherit'});
if(hash(fs.readFileSync(path.join(work,'source/media-decoder.cc')))!=='54688adee86dd8c0d748ca260b9d51255ffe33189daf3f284c1783af21b5e00e')throw Error('Patched media source hash mismatch');
cmd('patch',['-p1','-i',path.join(root,'patches/nxjs-video-track-timeline.patch')],{cwd:work,stdio:'inherit'});
for(const [n,h] of Object.entries({"media-decoder.cc":"ba3568226f639d12c0b820de662bcb8d09437438c8f11c5c4188c699d2761ced","media-decoder.h":"2f9d816880b9ed51f101fa7fbc32bf4666ef434faecddc2d1306b59556ea9d22","audio-graph.cc":"a1c56f338022d3a6ea93893555c29da9c92473e121007d53ce1734d803afbe96","audio-graph.h":"f0ae69e9ef63357e520b7e9869097ecc5392121cb3ec32422dcf263008eb8c1c"})){if(hash(fs.readFileSync(path.join(work,'source',n)))!==h)throw Error('Patched timeline source hash mismatch: '+n);}

const require=createRequire(import.meta.url),stock=fs.readFileSync(path.join(path.dirname(require.resolve('@nx.js/nro/dist/main.js')),'nxjs.nro'));
if(hash(stock)!=='602ced49d93afc1704c8dd14da199b151201cb9bcd55ce3b75738f5ae39637ae')throw Error('Unverified npm nx.js runtime');
const marker=Buffer.from('//# sourceMappingURL=runtime.js.map'),end=stock.indexOf(marker),begin=stock.lastIndexOf(0,end)+1;if(end<0)throw Error('Missing script');const js=stock.subarray(begin,end+marker.length);
if(hash(js)!=='d960185c65abf7944e979820b28c3fafb43156548500910c27595a4ee7341465')throw Error('Unexpected embedded runtime.js');
const rom=await romDecode((await nroDecode(new Blob([stock]))).romfs);const write=(p,v)=>{const to=path.join(work,p);fs.mkdirSync(path.dirname(to),{recursive:true});fs.writeFileSync(to,v);};
write('packages/runtime/runtime.js',Buffer.concat([js,Buffer.from('\n')]));write('packages/runtime/runtime.js.map',Buffer.from(await rom['runtime.js.map'].arrayBuffer()));write('packages/runtime/node_modules/geist/dist/fonts/geist-mono/GeistMono-Regular.ttf',Buffer.from(await rom['GeistMono.ttf'].arrayBuffer()));
const args=['-j'+Math.max(1,Math.min(12,Number(process.env.JOBS)||4)),`DEFINES=-ffile-prefix-map=${sdk}=/opt/devkitpro -ffile-prefix-map=${work}=/build/nxjs`,'LIBNX_VERSION=4.12.0','LIBTURBOJPEG_VERSION=2.1.2'];
cmd('make',args,{cwd:work,env:{...process.env,DEVKITPRO:sdk,PATH:[path.join(sdk,'devkitA64/bin'),path.join(sdk,'tools/bin'),process.env.PATH].join(':')},stdio:'inherit'});
const raw=fs.readFileSync(path.join(work,'nxjs.nro')),n=raw.readUInt32LE(24),exe=raw.subarray(0,n);if(raw.toString('ascii',n,n+4)!=='ASET')throw Error('No ASET');
const actual=hash(exe);console.log('Built NRO executable SHA-256:',actual);if(actual!==pinnedCode)throw Error('Different linker output: keep for inspection; NOT replacing the distributed build. Use the documented SDK and path maps.');
write('nxjs-preroll.nro-code.gz',gzipSync(exe,{level:6}));console.log('Recreated verified executable; the project and upstream checkout were not overwritten.');
