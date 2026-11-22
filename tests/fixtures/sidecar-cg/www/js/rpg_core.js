// Original MV-shaped diagnostic. The MP4 has NO sound stream; all audible samples must come from the external Ogg.
globalThis.StorageManager={};globalThis.LZString={};
globalThis.Graphics={_width:816,_height:624,render(){this.paint?.();this._rendered=true;}};
globalThis.sidecarTest={phase:'starting',rounds:[],storyCount:0};
globalThis.onload=function(){
  const S=sidecarTest,c=document.createElement('canvas');c.width=816;c.height=624;c.id='GameCanvas';document.body.appendChild(c);
  const g=c.getContext('2d'),v=document.createElement('video');v.id='GameVideo';v.style.opacity=0;document.body.appendChild(v);
  let idx=0,round,voice,released=false;
  function playBoth(){
    if(S.phase!=='loading'||v.readyState<2||voice.readyState<2)return;
    S.phase='playing';v.style.opacity=1;
    Promise.all([v.play(),voice.play()]).catch(e=>{S.phase='error';S.why=String(e);v.style.opacity=0;});
  }
  function endIfBoth(){
    if(round.videoEnd!==1||round.soundEnd!==1)return;
    S.storyCount++;v.style.opacity=0;voice.pause();voice.src='';v.pause();v.src='';
    S.phase=idx===2?'done':'between';if(idx===1)setTimeout(next,650);else released=false;
  }
  function next(){
    try{
      const n=idx++;round={path:n?'constructor-source':'DOM-src',videoEnd:0,soundEnd:0,videoPlay:0,soundPlay:0};S.rounds.push(round);S.phase='loading';
      v.src='movies/picture-only.mp4';v.onloadeddata=playBoth;v.onplay=()=>round.videoPlay++;
      v.onended=()=>{round.videoEnd++;v.style.opacity=0;endIfBoth();};v.onerror=()=>{S.why=v.error?.message||'video load failed';S.phase='error';};
      voice=n?new Audio():document.createElement('audio');voice.volume=.85;
      voice.oncanplaythrough=playBoth;voice.onplay=()=>round.soundPlay++;voice.onended=()=>{round.soundEnd++;endIfBoth();};voice.onerror=()=>{S.why=voice.error?.message||'audio load failed';S.phase='error';};
      if(n){for(const path of ['audio/missing.ogg','audio/voice.ogg']){const s=document.createElement('source');s.src=path;s.type='audio/ogg; codecs="opus"';voice.appendChild(s);}}
      else voice.src='audio/voice.ogg';
      voice.load();v.load();playBoth();
    }catch(e){S.phase='error';S.why=String(e);v.style.opacity=0;}
  }
  Graphics.paint=()=>{
    if(+v.style.opacity>0)return;
    g.fillStyle=S.phase==='done'?'#205835':'#193448';g.fillRect(0,0,816,624);g.fillStyle='#fff';g.font='26px sans-serif';g.fillText('BurialNX  /  separate soundtrack',38,82,740);g.font='19px sans-serif';
    if(S.phase==='prompt'){g.fillText('A: play two 4-second clips. Each contains four white flashes.',38,161,740);g.fillText('Skip if flashing images are uncomfortable. Use a comfortable volume.',38,211,740);}
    else if(S.phase==='done')g.fillText('DONE 2/2: two videos and two external soundtracks ended. A: replay.',38,161,740);
    else if(S.phase==='error')g.fillText('ERROR: '+S.why,38,161,740);else g.fillText('Clip '+idx+' ('+(round?.path||'')+'), completed: '+S.storyCount,38,161,740);
    g.fillText('The MP4 has no audio. Each flash should match a stereo tone from the Ogg.',38,288,740);
  };
  S.phase='prompt';function tick(){const a=!!navigator.getGamepads?.()[0]?.buttons?.[1]?.pressed;if(!a)released=true;
    if(released&&a&&(S.phase==='prompt'||S.phase==='done')){idx=0;S.rounds=[];S.storyCount=0;released=false;next();} Graphics.render();requestAnimationFrame(tick);
  }tick();
};
