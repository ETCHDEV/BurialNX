// Test the NEW optional device kit using the already shipped NRO. In this driver
// the 'physical Switch' answer is always NO. Synthetic buttons are never device evidence.
import {strict as assert} from 'node:assert';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {setTimeout as sleep} from 'node:timers/promises';
import {packageInput,sha} from './package-input.mjs';import {boot} from './host.mjs';
const [release,fixture,scenario,summaryFile]=process.argv.slice(2);const scenarios=['reference','blank','missing','own','own-webm','discard'];assert(scenarios.includes(scenario));
if((scenario==='blank')!==(process.env.CG_NEGATIVE==='av-off'))throw Error('Negative A/V control flag mismatch');
const bytes=(z,n)=>execFileSync('unzip',['-p',z,n],{maxBuffer:100*1024*1024});const g='sdmc:/BurialNX-CG-check/www/';const p=await packageInput(release);const files=new Map();
for(const f of ['index.html','js/device-metrics.js','js/rpg_core.js','movies/sync.mp4','movies/sync.webm'])files.set(g+f,bytes(fixture,'BurialNX-CG-device-check/www/'+f));
assert.equal(sha(files.get(g+'movies/sync.mp4')),p.provenance.fixtureSha256['movies/sync.mp4']);assert.equal(sha(files.get(g+'movies/sync.webm')),p.provenance.fixtureSha256['movies/sync.webm']);
files.set('sdmc:/switch/burialnx/burialnx.nro',bytes(release,'switch/burialnx/burialnx.nro'));if(scenario==='own')files.set(g+'movies/my-cutscene-mp4.mp4',files.get(g+'movies/sync.mp4'));if(scenario==='own-webm')files.set(g+'movies/my-cutscene-webm.webm',files.get(g+'movies/sync.webm'));
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'cg-check-interactive-'));let h;
try{
 h=await boot({...p,files},scratch,scenario.startsWith('own')?'direct':'scaled');const {state,cx}=h;const sw=cx.Switch,dir='sdmc:/switch/burialnx/CG-CHECK';const pressed=new Set();cx.navigator.getGamepads=()=>[{buttons:Array.from({length:16},(_,i)=>({pressed:pressed.has(i),value:+pressed.has(i)})),axes:[0,0,0,0]}];
 const text=[];state.texts.includes=function(s){if(!text.includes(s))text.push(s);return Array.prototype.includes.call(this,s);};
 let i=0;const start=performance.now();
 async function tick(){state.t=Math.round(i*1024/48);h.observe();h.pumpAudio(1024);h.pumpFrames();h.observe();if(state.fatal)throw state.fatal;i++;await sleep(Math.max(0,start+i*1024/48-performance.now()));}
 async function until(s,ms=9500){text.length=0;const until=performance.now()+ms;while(performance.now()<until){await tick();if(text.some(t=>t.includes(s)))return;}throw Error('Timed out waiting for '+s+': '+JSON.stringify({latest:state.lastText,events:state.events}));}
 async function tap(b){pressed.clear();await tick();await tick();pressed.add(b);await tick();pressed.clear();await tick();}
 async function tapThen(b,s,ms=9500){text.length=0;await tap(b);if(!text.some(t=>t.includes(s)))await until(s,ms);}
 const list=()=>sw.readDirSync(dir+'/')||[];const clipAnswers=scenario==='missing'||scenario==='discard'?['no','no','unsure']:scenario==='blank'?['yes','yes','yes']:['unsure','unsure','unsure'];const keyFor=v=>v==='yes'?1:v==='no'?0:3;
 await until('Choose a check');for(let j=0;j<8;j++)await tick();assert.deepEqual(state.events,[]);assert.deepEqual(list(),[]);
 if(scenario==='missing'||scenario==='own'||scenario==='discard')await tap(13);else if(scenario==='own-webm')await tap(12);
 await tapThen(1,'A: start');assert.deepEqual(state.events,[],'two separate confirmations before flashing');await tapThen(1,'Observation 1/3',10000);
 const count=scenario==='blank'||scenario==='reference'?2:1;
 for(let n=0;n<count;n++){
   await tapThen(keyFor(clipAnswers[0]),'Observation 2/3');await tapThen(keyFor(clipAnswers[1]),'Observation 3/3');
   if(n+1<count){await tapThen(keyFor(clipAnswers[2]),'A: start next clip');await tapThen(1,'Observation 1/3',10000);}
   else await tapThen(keyFor(clipAnswers[2]),'PHYSICAL Nintendo Switch');
 }
 assert.deepEqual(list(),[]);await tapThen(0,'A: save local JSON');assert.deepEqual(list(),[],'not written by successful playback or answering the questions');
 if(scenario==='discard'){await tapThen(0,'Choose a check');assert.deepEqual(list(),[]);console.log('PASS: discard generated zero report files');if(summaryFile)fs.writeFileSync(summaryFile,JSON.stringify({scenario,discardWrites:0,scope:'desktop QA'}));}
 else {
   await tapThen(1,'Report saved locally:');const saved=list().filter(n=>/^result-[0-9-]+\.json$/.test(n));assert.equal(saved.length,1);const r=JSON.parse(new TextDecoder().decode(sw.readFileSync(dir+'/'+saved[0])));
   assert.equal(r.physicalSwitch,'no');assert.equal(r.verdict,'NO_PHYSICAL_CONFIRMATION');assert.equal(r.nroDisplayVersion,cx.CGDeviceCheck.build);assert.equal(r.clips.length,count);assert.ok(!JSON.stringify(r).includes('sdmc:')&&!JSON.stringify(r).includes('normal SD'));assert(!list().some(n=>n.endsWith('.part')));
   for(const c of r.clips){assert.equal(c.returnMarkers,2,'both final-screen colors must really return');assert.deepEqual(Object.values(c.operator),clipAnswers);
     if(scenario==='missing'){assert.equal(c.problem,'source-or-decoder-error');assert.equal(c.events.ended,0);assert(!c.assessment.visualAndReturnChecksPassed);}
     else if(scenario==='blank'){assert.equal(c.problem,null);assert(c.media.presentedFrames>=24&&c.events.ended===1);assert.equal(c.screen.whiteOnsetsMediaMs.length,0);assert(!c.assessment.visualAndReturnChecksPassed);assert.equal(c.assessment.human,'all-three-observed');}
     else {assert(c.assessment.visualAndReturnChecksPassed,'missing necessary final pixels: '+JSON.stringify(c));assert.equal(c.problem,null);assert.equal(c.events.ended,1);assert.equal(c.assessment.human,'not-fully-observed');}
   }
   const summary={scenario,testPlatform:'desktop simulated buttons; not physical evidence',reportSavedOnlyAfterConsent:true,verdict:r.verdict,reportSize:JSON.stringify(r).length,clips:r.clips.map(c=>({id:c.id,problem:c.problem,events:c.events,screenSamples:c.screen.samples,distinct:c.screen.distinct,flashes:c.screen.whiteOnsetsMediaMs.length,returnMarkers:c.returnMarkers,visualChecks:c.assessment.visualAndReturnChecksPassed,manual:c.assessment.human}))};console.log(JSON.stringify(summary));if(summaryFile)fs.writeFileSync(summaryFile,JSON.stringify(summary,null,2));
 }
}finally{h?.close();fs.rmSync(scratch,{recursive:true,force:true});}
