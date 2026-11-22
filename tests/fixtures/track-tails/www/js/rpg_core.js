// Original diagnostic scene; Graphics, ResourceHandler and Game_Interpreter
// are separate, unmodified MIT-licensed MV modules. This script deliberately
// leaves Graphics.playVideo, the player events and command261/updateWait intact.
globalThis.makeVideoPlayableInline=()=>{};
globalThis.Utils={isMobileDevice:()=>false};globalThis.StorageManager={};globalThis.LZString={};
globalThis.SceneManager={isSceneChanging:()=>false};globalThis.$gameMap={mapId:()=>1};globalThis.$gameMessage={isBusy:()=>false};
globalThis.tailTest={phase:'starting',storyCount:0,waitFrames:[0,0],advancedOverVideo:[],backgroundColors:[[17,42,64],[51,68,153],[131,47,85]]};
globalThis.onload=function(){
  const d=tailTest;Graphics._width=816;Graphics._height=624;Graphics._realScale=1;Graphics._createCanvas();Graphics._createVideo();
  const ctx=Graphics._canvas.getContext('2d');const interpreter=new Game_Interpreter();let released=false;d.phase='prompt';
  function begin(){
    d.storyCount=0;d.advancedOverVideo=[];d.waitFrames=[0,0];d.phase='playing';released=false;
    const movie=name=>({code:261,indent:0,parameters:[name]});const script=js=>({code:355,indent:0,parameters:[js]});
    interpreter.setup([movie('short-audio'),script('tailTest.advancedOverVideo.push(Graphics.isVideoPlaying());tailTest.storyCount++;'),{code:230,indent:0,parameters:[30]},movie('short-video'),script('tailTest.advancedOverVideo.push(Graphics.isVideoPlaying());tailTest.storyCount++;tailTest.phase="done";'),{code:0,indent:0,parameters:[]}],1);
  }
  function tick(){
    const a=!!navigator.getGamepads?.()[0]?.buttons?.[1]?.pressed;
    if(!a)released=true;
    if((d.phase==='prompt'||d.phase==='done')&&a&&released)begin();
    if(d.phase==='playing'){
      interpreter.update();
      if(interpreter._waitMode==='video'&&d.storyCount<2)d.waitFrames[d.storyCount]++;
    }
    if(!Graphics.isVideoPlaying()){
      const color=d.backgroundColors[d.storyCount];ctx.fillStyle='rgb('+color.join(',')+')';ctx.fillRect(0,0,816,624);
      ctx.fillStyle='#fff';ctx.font='27px sans-serif';ctx.fillText('BurialNX  /  unequal track lengths',35,73,740);
      ctx.font='20px sans-serif';ctx.fillText(d.phase==='prompt'?'A: start (two clips; comfortable volume)':d.phase==='done'?'DONE 2/2 - scene control returned. A: replay.':'First movie ended. Next movie loads after a short pause.',35,139,743);
      ctx.fillText('1. Sound stops after 1 s. Video continues to green at 3.5 s.',35,236,740);
      ctx.fillText('2. Picture ends after 1 s. Sound continues until 4 s.',35,284,740);
      ctx.fillText('The engine must wait for both streams, then return here.',35,385,740);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
};
