// Original optional diagnostic. No microphone, network, images, PCM or game saves are collected.
(() => {
  const schema = 'burialnx-device-check/1', build = '0.1.6-cg.6';
  const dir = 'sdmc:/switch/burialnx/CG-CHECK';
  const options = {
    reference: [{id:'ref-mp4',file:'sync.mp4',reference:true},{id:'ref-webm',file:'sync.webm',reference:true}],
    personalMp4: [{id:'personal-mp4',file:'my-cutscene-mp4.mp4',reference:false}],
    personalWebm: [{id:'personal-webm',file:'my-cutscene-webm.webm',reference:false}]
  };
  function assess(c) {
    const reference = c.id === 'ref-mp4' || c.id === 'ref-webm';
    const pulses = c.screen.whiteOnsetsMediaMs;
    const checks = {
      oneReadyOneEnd: c.events.ready === 1 && c.events.ended === 1 && !c.problem,
      decodedPicture: c.media.width > 0 && c.media.height > 0 && c.media.presentedFrames >= 2,
      clockAdvanced: c.media.furthestMs > 0 && c.media.durationMs > 0,
      reachedNearEnd: c.media.durationMs > 0 && c.media.furthestMs >= c.media.durationMs * 0.9 && c.media.furthestMs + 1500 >= c.media.durationMs,
      changingScreen: c.screen.samples >= 2 && c.screen.distinct >= 2,
      returnedToGame: c.returnMarkers === 2
    };
    if (reference) {
      checks.referenceTiming = c.media.width === 640 && c.media.height === 360 && c.media.durationMs >= 3750 && c.media.durationMs <= 4250 && c.media.furthestMs >= 3200;
      checks.fourWhiteFlashes = pulses.length === 4 && pulses.every((v,i) => Number.isFinite(v) && Math.abs(v-i*1000) <= 350);
      checks.referenceMotion = c.screen.distinct >= 8;
      checks.referenceFrameCoverage = c.media.presentedFrames >= 86 && (c.media.presentedFrames / Math.max(1,c.media.presentedFrames + c.media.droppedFrames)) >= 0.9;
    }
    // Audio and perceived synchrony are EXPLICIT human observations, never inferred
    // from play(), video counters, the existence of a sound track, or onscreen flashes.
    const answers = ['picture','sound','sync'].map(k => c.operator[k]);
    return {checks, visualAndReturnChecksPassed:Object.values(checks).every(Boolean),
      human: answers.includes('no') ? 'problem-observed' : answers.every(a=>a==='yes') ? 'all-three-observed' : 'not-fully-observed'};
  }
  function verdict(report) {
    const expected=options[report.run]?.map(c=>c.id) || [];
    const complete=expected.length>0 && expected.length===report.clips.length && expected.every((id,i)=>report.clips[i].id===id);
    const tested=report.clips.map(assess);
    if (report.physicalSwitch !== 'yes') return 'NO_PHYSICAL_CONFIRMATION';
    if (tested.some(t=>t.human==='problem-observed') || report.clips.some(c=>c.problem)) return 'PROBLEM_OBSERVED';
    if (complete && [build,'0.1.6-cg.5','0.1.6-cg.4','0.1.6-cg.3','0.1.6-cg.2'].includes(report.nroDisplayVersion) && tested.every(t=>t.visualAndReturnChecksPassed && t.human==='all-three-observed')) return 'OBSERVED_PASS_FOR_TESTED_CLIPS';
    return 'INCONCLUSIVE';
  }
  const text = a => new TextDecoder().decode(a);
  async function versionFromArgv(fs) {
    try {
      const p=fs?.argv?.[0];
      if(typeof p!=='string' || !/^sdmc:\/[^?#\\\u0000-\u001f]*\.nro$/i.test(p) || p.slice(6).split('/').some(s=>!s||s==='.'||s==='..')) return null;
      const slice=async (start,n)=>{const b=await fs.readFile(p,{start,end:start+n});if(!b||b.byteLength<n||b.byteLength>n+1)throw Error('bounded read unavailable');return new Uint8Array(b,0,n);};
      const header=await slice(0,32);if(text(header.subarray(16,20))!=='NRO0')return null;
      const end=new DataView(header.buffer,header.byteOffset).getUint32(24,true);if(end<64||end>256*1024*1024)return null;
      const assets=await slice(end,56);if(text(assets.subarray(0,4))!=='ASET')return null;
      const view=new DataView(assets.buffer,assets.byteOffset);const off=Number(view.getBigUint64(24,true)),sz=Number(view.getBigUint64(32,true));
      if(!Number.isSafeInteger(off)||off<56||off>64*1024*1024||!Number.isSafeInteger(sz)||sz<0x3070)return null;
      const val=text(await slice(end+off+0x3060,16)).split('\0')[0];return /^[a-z\d.\-+]{1,15}$/i.test(val)?val:null;
    } catch {return null;}
  }
  function save(fs,report) {
    if (report.schema!==schema || !Array.isArray(report.clips)) throw Error('Invalid check result');
    const data=JSON.stringify(report,null,2)+'\n';if(data.length>24000)throw Error('Result too large');
    if(!fs?.statSync || !fs?.mkdirSync || !fs?.writeFileSync || !fs?.readFileSync || !fs?.renameSync || !fs?.removeSync)throw Error('SD file API unavailable');
    if(!fs.statSync(dir)) fs.mkdirSync(dir);
    if((fs.statSync(dir)?.mode&0o170000)!==0o040000)throw Error('Report folder unavailable');
    const stamp=new Date().toISOString().replace(/\D/g,'').slice(0,17);
    let file=null;
    for(let i=0;i<64;i++) {const candidate='result-'+stamp+'-'+i+'.json';if(!fs.statSync(dir+'/'+candidate)&&!fs.statSync(dir+'/'+candidate+'.part')){file=candidate;break;}}
    if(!file)throw Error('Pick another time to save');
    const out=dir+'/'+file,part=out+'.part';let owned=false;
    try {
      owned=true;fs.writeFileSync(part,data);
      const bytes=fs.readFileSync(part);if(!bytes || text(bytes)!==data)throw Error('Incomplete SD write');
      if(fs.statSync(out))throw Error('Name conflict; previous result kept');
      fs.renameSync(part,out);owned=false;
      if(!fs.statSync(out))throw Error('Report not found after rename');
      return file;
    } finally {if(owned){try{fs.removeSync(part);}catch{}}}
  }
  globalThis.CGDeviceCheck = {schema,build,dir,options,assess,verdict,versionFromArgv,save};
})();
