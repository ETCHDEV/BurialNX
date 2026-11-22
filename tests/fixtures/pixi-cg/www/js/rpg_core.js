// Original synthetic scene. The separately distributed unmodified PixiJS is MIT licensed.
// No new Video(), direct video.src setter, manual playing or attachment to document.body
// on the happy loading path: Pixi selects <source> and autoplays through its own APIs.
globalThis.StorageManager={}; globalThis.LZString={};
globalThis.Graphics={_width:816,_height:624,render(){this.renderSprite?.();this._rendered=true;}};
globalThis.textureTest={phase:'starting',clips:[]};
globalThis.onload=function(){
  const d=textureTest;
  try {
    const P=globalThis.PIXI||globalThis.module.exports;d.version=P.VERSION;
    const view=document.createElement('canvas');view.width=816;view.height=624;view.id='GameCanvas';document.body.appendChild(view);
    const renderer=new P.CanvasRenderer({width:816,height:624,view,transparent:false,backgroundColor:0x173046,resolution:1});
    const scene=new P.Container(), ctx=view.getContext('2d'); let pos=0, mode='reference',released=false;
    d.phase='prompt';
    const onError=e=>{d.phase='error';d.why=String(e?.message||e);};
    function next(){
      if(pos===(mode==='reference'?2:1)){renderer.backgroundColor=0x246d3b;d.phase='returned';released=false;return;}
      const idx=pos++;let sources;
      if(mode==='mp4') sources='movies/my-texture.mp4';
      else if(mode==='webm') sources='movies/my-texture.webm';
      else if(!idx) sources='movies/sync.mp4';
      else sources=[{src:'movies/never-use.mp4',mime:'video/unsupported'},
        {src:'movies/missing-file.webm',mime:'video/webm'},
        {src:'movies/mislabeled.webm',mime:'video/webm'},
        {src:'movies/broken.webm',mime:'video/webm'},
        {src:'movies/sync.webm',mime:'video/webm'}];
      const texture=P.Texture.fromVideoUrl(sources), base=texture.baseTexture,video=base.source;
      const childNodes=video.getElementsByTagName('source');
      const track={ready:0,plays:0,ends:0,errors:0,loaded:0,rejected:[],detached:video.parentNode==null,sourceChildren:childNodes.length};d.clips.push(track);
      for(const candidate of childNodes)candidate.addEventListener('error',()=>track.rejected.push(candidate.src));
      const sp=new P.Sprite(texture);sp.position.set(248,222);sp.scale.set(.5);scene.addChild(sp);
      // Fit a personal clip inside the same 320 x 180 box without changing its aspect ratio.
      base.on('loaded',()=>{track.loaded++;if(mode!=='reference'&&base.width>0&&base.height>0)sp.scale.set(Math.min(320/base.width,180/base.height));});
      video.addEventListener('loadeddata',()=>track.ready++);video.addEventListener('play',()=>track.plays++);
      video.addEventListener('error',()=>{track.errors++;onError(video.error?.message||'No playable source');});
      video.addEventListener('ended',()=>{
        track.ends++;track.currentSrc=video.currentSrc;track.directSrc=video.src;track.w=base.width;track.h=base.height;track.quality=video.getVideoPlaybackQuality();
        scene.removeChild(sp);video.pause();video.src='';sp.destroy({texture:true,baseTexture:true});setTimeout(()=>{try{next();}catch(e){onError(e);}},220);
      });
    }
    function start(choice){mode=choice;pos=0;d.clips=[];d.phase='test';released=false;renderer.backgroundColor=0x173046;next();}
    Graphics.renderSprite=()=>{
      renderer.render(scene);
      ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;ctx.fillStyle='#fff';ctx.font='24px sans-serif';
      ctx.fillText('BurialNX  /  PixiJS video texture',32,44,745);
      ctx.font='18px sans-serif';
      if(d.phase==='prompt'||d.phase==='returned'){
        ctx.fillText(d.phase==='returned'?'DONE - both sound and motion must be checked by you.':'Movie stays INSIDE the game scene. This is not fullscreen video.',32,98,745);
        ctx.fillText('A: reference MP4 + WebM. Each has 4 flashes and 4 tones.',32,151,745);
        ctx.fillText('Skip the reference clips if flashing images are uncomfortable.',32,187,745);
        ctx.fillText('X: my-texture.mp4   /   Y: my-texture.webm   (put a copy in www/movies)',32,245,745);
      }else if(d.phase==='test'){
        ctx.fillText('Playing in the center. The blue game background should stay visible.',32,115,745);
      }else if(d.phase==='error')ctx.fillText('Could not play: '+d.why,32,132,745);
      ctx.restore();
    };
    function tick(){try{const b=navigator.getGamepads?.()[0]?.buttons||[];const a=!!b[1]?.pressed,x=!!b[2]?.pressed,y=!!b[3]?.pressed;
      if(!a&&!x&&!y)released=true;
      if((d.phase==='prompt'||d.phase==='returned')&&released&&(a||x||y))start(a?'reference':x?'mp4':'webm');
      Graphics.render();requestAnimationFrame(tick);
    }catch(e){onError(e);}}tick();
  }catch(e){d.phase='error';d.why=String(e);}
};
