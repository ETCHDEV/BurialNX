// Original minimal MV-shaped test harness. No RPG Maker engine or commercial game assets.
// Match the DOM call order of the MV Play Movie event; don't touch existing game saves.
globalThis.StorageManager = {}; globalThis.LZString = {};
globalThis.Graphics = { _width: 816, _height: 624, render() { this.paint?.(); } };
globalThis.onload = function () {
  const canvas = document.createElement('canvas'); canvas.id = 'GameCanvas';
  canvas.width = 816; canvas.height = 624; document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const movie = document.createElement('video'); movie.id = 'GameVideo'; movie.style.opacity = 0;
  movie.setAttribute('playsinline', ''); movie.volume = .85; document.body.appendChild(movie);
  const playlist = ['sync.mp4', 'sync.webm']; let i = 0, stage = 'Preparing the two clips...';
  let error = '', waiting = false, previous = true, endedCount = 0;
  function playNext() {
    if (i === playlist.length) { stage = 'DONE: both movies ended; game control returned.'; waiting = false; return; }
    const file = playlist[i++]; stage = 'Opening ' + file; waiting = true;
    movie.src = 'movies/' + file;
    movie.onloadeddata = () => { stage = 'Playing ' + file; movie.style.opacity = 1; movie.play(); };
    movie.onerror = () => { movie.style.opacity = 0; error = file + ': ' + (movie.error?.message || 'decoder error'); waiting = false; };
    movie.onended = () => { movie.style.opacity = 0; endedCount++; stage = 'Ended: ' + file; setTimeout(playNext, 900); };
    movie.load();
  }
  Graphics.paint = () => {
    if (+movie.style.opacity > 0) return;
    ctx.fillStyle = '#163247'; ctx.fillRect(0,0,816,624); ctx.fillStyle = '#ffffff'; ctx.font = '25px sans-serif';
    ctx.fillText('BurialNX  /  movie & sound check', 40, 108);
    ctx.font = '20px sans-serif'; ctx.fillText(error ? 'ERROR: ' + error : stage, 40, 183, 730);
    ctx.fillText('Each clip: moving test pattern, four white flashes + four short tones.',40,245,730);
    ctx.fillText('H.264/AAC MP4, then VP8/Opus WebM. Ended: '+endedCount+'/2',40,293,730);
    if (!waiting) ctx.fillText('A: replay both     |     Hold Minus: BurialNX menu',40,387,730);
  };
  function tick() {
    Graphics.render(); const pressed = !!navigator.getGamepads?.()[0]?.buttons?.[1]?.pressed;
    if (!waiting && pressed && !previous) { i=0; endedCount=0; error=''; playNext(); }
    previous = pressed; requestAnimationFrame(tick);
  }
  tick(); setTimeout(playNext, 900);
};
