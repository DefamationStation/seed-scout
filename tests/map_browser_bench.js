// Run in the isolated test page's developer console after opening the benchmark seed.
window.benchMap = async (x, bpp = 3, pan = false) => {
  await fetch('/bench/reset', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  worldMap.layers.structures = false;
  if (pan) { worldMap.jump(x-20000,x-20000,bpp); await new Promise(r=>setTimeout(r,220)); }
  const start = performance.now(); let first = null, complete = null, maxLoaded = 0;
  const observer = new MutationObserver(() => {
    const text = document.getElementById('status-tiles').textContent;
    const loaded = Number(text.split('loading ')[1]?.split('/')[0] || 0);
    maxLoaded = Math.max(maxLoaded,loaded);
    if (first === null && loaded > 0) first = performance.now()-start;
    if (!text.includes('loading') && maxLoaded > 0) complete = performance.now()-start;
  });
  observer.observe(document.getElementById('status-tiles'),{childList:true});
  try {
    worldMap.jump(x,x,bpp);
    await new Promise((resolve,reject) => {
      const poll = () => {
        if (complete !== null) return requestAnimationFrame(()=>requestAnimationFrame(resolve));
        if (performance.now()-start > 15000) return reject(new Error('Map benchmark timed out'));
        setTimeout(poll,10);
      }; poll();
    });
    return {x,bpp,pan,first,complete,painted:performance.now()-start,
      canvas:[document.getElementById('terrain-canvas').clientWidth,document.getElementById('terrain-canvas').clientHeight]};
  } finally { observer.disconnect(); }
};
