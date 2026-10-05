'use strict';
// What the page remembers (conditions, presets, layers, the last view) lives in the browser's storage, which
// belongs to the address the page is served from. The desktop app is given a new port each time it starts, so
// that storage came back empty after every restart and update. The backend therefore keeps a copy in the data
// folder: an empty storage is filled from it before anything else runs, and every change is written back.
(() => {
  const mine = key => typeof key === 'string' && key.startsWith('seed-scout-');
  const snapshot = () => { const all = {}; for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (mine(key)) all[key] = localStorage.getItem(key); } return all; };
  try {
    if (!Object.keys(snapshot()).length) {
      // Synchronous on purpose: the scripts after this one read the storage as they load.
      const request = new XMLHttpRequest(); request.open('GET', '/api/page-state', false); request.send();
      const kept = request.status === 200 ? JSON.parse(request.responseText).state || {} : {};
      for (const [key, value] of Object.entries(kept)) if (mine(key) && typeof value === 'string') localStorage.setItem(key, value);
    }
  } catch { }
  let timer = 0;
  const push = () => { clearTimeout(timer); timer = setTimeout(() => { fetch('/api/page-state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: snapshot() }), keepalive: true }).catch(() => { }); }, 600); };
  const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (key, value) { set.call(this, key, value); if (this === localStorage && mine(key)) push(); };
  Storage.prototype.removeItem = function (key) { remove.call(this, key); if (this === localStorage && mine(key)) push(); };
})();
