// Desktop QA only: compile the N-API binding against the exact same four nx.js
// media/graph source files. Neither this library nor the test harness is in the NRO.
import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const [source,output,kind='movie']=process.argv.slice(2);if(!['movie','sidecar'].includes(kind))throw Error('Expected movie or sidecar binding');if(!source||!output)throw Error('Usage: node build-native.mjs /path/to/nx.js/source scratch/decoder.node');
const decoderHash=createHash('sha256').update(readFileSync(join(source,'media-decoder.cc'))).digest('hex');
if(!['63f1fc541f57dc44b802e99744e2e0f824d9f99668cc6c8402c529c13a5a2327','54688adee86dd8c0d748ca260b9d51255ffe33189daf3f284c1783af21b5e00e','ba3568226f639d12c0b820de662bcb8d09437438c8f11c5c4188c699d2761ced'].includes(decoderHash))throw Error('Unreviewed native movie decoder');
const pins={'media-decoder.cc':decoderHash,'media-decoder.h':'2f9d816880b9ed51f101fa7fbc32bf4666ef434faecddc2d1306b59556ea9d22','audio-graph.cc':'6bdb28a65b823cd84af8193709c68bb5e8e834c022367710f3ebdd2736ca6cfb','audio-graph.h':'fcb88ab6957124d1b4c21a7104c7d6631b6f25c6ebb39c7a12a9746f9993cfed'};
if(decoderHash==='ba3568226f639d12c0b820de662bcb8d09437438c8f11c5c4188c699d2761ced'){pins['audio-graph.cc']='a1c56f338022d3a6ea93893555c29da9c92473e121007d53ce1734d803afbe96';pins['audio-graph.h']='f0ae69e9ef63357e520b7e9869097ecc5392121cb3ec32422dcf263008eb8c1c';}
for(const [n,h] of Object.entries(pins))if(createHash('sha256').update(readFileSync(join(source,n))).digest('hex')!==h)throw Error('Incorrect nx.js native source: '+n);
const headers=process.env.NODE_INCLUDE||resolve(dirname(process.execPath),'../include/node');if(!existsSync(join(headers,'node_api.h')))throw Error('Set NODE_INCLUDE to the Node include directory.');
const flags=execFileSync('pkg-config',['--cflags','--libs','libavcodec','libavformat','libswscale','libswresample','libavutil'],{encoding:'utf8'}).trim().split(/\s+/);
mkdirSync(dirname(resolve(output)),{recursive:true});execFileSync(process.env.CXX||'c++',['-std=c++17','-O2','-pthread',`-DBURIALNX_DECODER_HASH="${decoderHash}"`,...(process.platform==='darwin'?['-bundle','-undefined','dynamic_lookup']:['-fPIC','-shared']),'-I',headers,'-I',source,fileURLToPath(new URL(kind==='sidecar'?'./sidecar-qa.cc':'./decoder.cc',import.meta.url)),join(source,'media-decoder.cc'),join(source,'audio-graph.cc'),...flags,'-o',resolve(output)],{stdio:'inherit'});
