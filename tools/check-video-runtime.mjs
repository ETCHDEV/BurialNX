import { createHash } from 'node:crypto';
import { decode as decodeNro } from '@tootallnate/nro';
import { decode as decodeRom } from '@tootallnate/romfs';

// SHA-256 of the NRO executable prefix [0, NRO.header.size), excluding the ASET
// section that changes with each app's icon, NACP and RomFS. The complete upstream
// nxjs.nro from GitHub v1.0.0-beta.7 also matches npm @nx.js/nro beta.7 byte-for-byte
// (602ced49d93afc1704c8dd14da199b151201cb9bcd55ce3b75738f5ae39637ae).
// Re-review decoder + drawImage + audio/unload APIs before accepting a new runtime.
import {gunzipSync} from 'node:zlib';
import {readFileSync} from 'node:fs';
const stockCode = '3fbafb0da26d7ba6e8a2c1be208d575559419b231365debda5046a81ed8df1a6';
export const pinnedCode = 'd19416181cc10974ac8b44f902fb0232f032f78e38021f7dbce1dcc3c2834cb6';
const digest = b => createHash('sha256').update(b).digest('hex');
// The gzip contains the ENTIRE normally compiled and linked ARM64 NRO program
// section. Its icon, NACP and application RomFS are still supplied by the packager.
export function installVideoRuntime(stock) {
  if (stock.toString('ascii',16,20)!=='NRO0') throw Error('Not an NRO');
  const n = stock.readUInt32LE(24);
  if(stock.toString('ascii',n,n+4)!=='ASET' || digest(stock.subarray(0,n))!==stockCode) throw Error('Unexpected upstream fat base');
  const native=gunzipSync(readFileSync(new URL('../runtime/nxjs-preroll.nro-code.gz',import.meta.url)),{maxOutputLength:64*1024*1024});
  if(native.toString('ascii',16,20)!=='NRO0' || native.readUInt32LE(24)!==native.length || digest(native)!==pinnedCode) throw Error('Native preroll fix missing or corrupted');
  return Buffer.concat([native,stock.subarray(n)]);
}

export async function checkVideoRuntime(buf) {
  if (buf.toString('ascii', 16, 20) !== 'NRO0') throw new Error('Not an NRO');
  const end = buf.readUInt32LE(24);
  if (buf.toString('ascii', end, end + 4) !== 'ASET') throw new Error('Invalid NRO executable size');
  const code = buf.subarray(0, end);
  const actual = createHash('sha256').update(code).digest('hex');
  if (actual !== pinnedCode) throw new Error(`Unverified nx.js movie runtime: executable SHA-256 ${actual}`);
  for (const name of ['videoLoad','videoTick','videoPlay','videoCreateAudioNode','videoClose','Matroska / WebM','libavcodec']) {
    if (!code.includes(Buffer.from(name))) throw new Error(`Missing expected movie backend: ${name}`);
  }
  const nro = await decodeNro(new Blob([buf]));
  const rom = await decodeRom(nro.romfs);
  const sources = JSON.parse(await rom['runtime.js.map'].text()).sources;
  const app = await rom['main.js'].text();
  if (!sources.some(name => /(?:^|\/)video\.ts$/.test(name)) ||
      !['createMovieLayer', 'createMovieResolver', 'setMovieSuspended', 'No decodable video frame', 'Movie source rejected:', 'HTMLSourceElement','HTMLAudioElement','createAudioResolver','Audio metadata:'].every(s => app.includes(s))) {
    throw new Error('Missing movie runtime map or MV movie adapter inside the final RomFS');
  }
  return 'Verified cross-built nx.js FFmpeg / Web Audio runtime with audio-preroll and independent track timelines (executable SHA-256 '+actual+').';
}
