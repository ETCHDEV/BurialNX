// Optional end-to-end desktop decode check. Requires Chromium/Chrome and the
// two original synthetic fixtures in tests/fixtures/cg/www/movies. No npm plugin,
// remote service, personal browser profile, game files or Switch keys required.
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const chrome=process.env.CHROME_BIN || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync);
if (!chrome) throw new Error('Set CHROME_BIN to Chrome/Chromium (desktop validation only)');
const source=(await build({entryPoints:[join(root,'tests/video-browser-probe.ts')],bundle:true,write:false,format:'iife',logLevel:'silent'})).outputFiles[0].contents;
const routes=new Map([['/', ['text/html','<!doctype html><title>Cutscene test</title><script defer src="/probe.js"></script><body></body>']],['/probe.js',['text/javascript',source]]]);
for(const [ext,type] of [['webm','video/webm'],['mp4','video/mp4']]) routes.set('/movies/sync.'+ext,[type,await readFile(join(root,'tests/fixtures/cg/www/movies/sync.'+ext))]);
const server=createServer((req,res)=>{const hit=routes.get(req.url);if(!hit){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':hit[0],'Cache-Control':'no-store'});res.end(hit[1]);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const profile=await mkdtemp(join(tmpdir(),'burialnx-chrome-')); let chromeProc;
try {
  chromeProc=spawn(chrome,['--headless=new','--disable-background-networking','--disable-component-update','--disable-breakpad','--no-first-run','--no-default-browser-check','--disable-sync','--disable-background-timer-throttling','--disable-renderer-backgrounding','--autoplay-policy=no-user-gesture-required','--remote-debugging-pipe',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','ignore','pipe','pipe']});
  let buffer='',seq=0;const pending=new Map();
  const fail=(err)=>{for(const item of pending.values())item.reject(err);pending.clear();};
  chromeProc.on('error',fail);chromeProc.on('exit',code=>fail(new Error('Desktop browser exited: '+code)));
  chromeProc.stdio[4].setEncoding('utf8');chromeProc.stdio[4].on('data',chunk=>{
    buffer+=chunk;let split;while((split=buffer.indexOf('\0'))!==-1){const txt=buffer.slice(0,split);buffer=buffer.slice(split+1);if(!txt)continue;const msg=JSON.parse(txt),item=pending.get(msg.id);if(!item)continue;pending.delete(msg.id);if(msg.error)item.reject(new Error(msg.error.message));else item.resolve(msg.result);}
  });
  function send(method,params={},sessionId){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Timed out: '+method));},40000);pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});chromeProc.stdio[3].write(JSON.stringify({id,method,params,sessionId})+'\0');});}
  const {targetId}=await send('Target.createTarget',{url:'about:blank'});const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  await send('Target.activateTarget',{targetId});await send('Page.bringToFront',{},sessionId);await send('Page.enable',{},sessionId);const url=`http://127.0.0.1:${server.address().port}/`;await send('Page.navigate',{url},sessionId);
  let loaded=false;for(let i=0;i<60;i++){const r=await send('Runtime.evaluate',{expression:'typeof runCgProbe === "function"'},sessionId);if(r.result?.value===true){loaded=true;break;}await new Promise(r=>setTimeout(r,100));}if(!loaded)throw new Error('Movie probe did not load');
  const r=await send('Runtime.evaluate',{expression:'runCgProbe()',awaitPromise:true,returnByValue:true,userGesture:true},sessionId);
  if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);console.log(JSON.stringify(r.result.value,null,2));
} finally {
  if(chromeProc && chromeProc.exitCode===null && chromeProc.signalCode===null){const closed=once(chromeProc,'exit').catch(()=>{});chromeProc.kill('SIGTERM');const kill=setTimeout(()=>chromeProc.kill('SIGKILL'),3000);await closed;clearTimeout(kill);}
  server.closeAllConnections();await new Promise(r=>server.close(r));await rm(profile,{recursive:true,force:true,maxRetries:3});
}
