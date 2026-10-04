// Progressive terrain map: overview first, zoom-dependent detail, structure layers and map tools.
// Shared helpers ($, api, esc, label, fmt, icon, ICONS, featureStyle, toast, copyText, catalog) live in app.js
// and are only used at runtime, after all scripts have loaded. Terrain appearance lives in terrain.js.
const worldMap = (() => {
  const LIMIT = 29980000, MIN_BPP = .0625, MAX_BPP = 64, CACHE_SIZE = 640, FEATURE_CACHE = 3000, TILE_REQUESTS = 3;
  const tileKey = (seed, x, z, step, mode) => `${seed}:${x}:${z}:${step}:${mode}`;
  // Default view scale, in blocks per screen pixel.
  const HOME_BPP = 3;
  // Zoom levels Z1 (farthest) to Z7 (closest), in blocks per pixel. A layer "from" a stop is drawn
  // once the map is zoomed in to that many blocks per pixel or fewer.
  const ZOOM_STOPS = [64, 32, 16, 8, 4, 2, 1];
  // Structure layers in order of importance, with the zoom stop each appears at by default:
  // rare landmarks from far out, common or small structures only up close. The stops follow measured
  // densities, so a layer's markers sit roughly 70 px or more apart when it first appears.
  const FEATURE_DEFAULTS = [
    ['strongholds', 64], ['woodland_mansions', 64],
    ['ancient_cities', 16], ['ocean_monuments', 16], ['villages', 16], ['pillager_outposts', 16],
    ['desert_pyramids', 8], ['jungle_temples', 8], ['swamp_huts', 8], ['igloos', 8], ['trail_ruins', 8], ['abandoned_camp', 8],
    ['trial_chambers', 4], ['huge_ruined_portals', 4], ['ruined_portals', 4], ['shipwrecks', 4], ['ocean_ruins', 4], ['buried_treasures', 4],
    ['mineshafts', 2],
  ];
  const DEFAULT_LAYERS = { basemap: 'biome', relief: true, contours: false, grid: false, slime: false, spawn: true, matches: true, labels: true, structures: true, features: {} };
  const layers = structuredClone(DEFAULT_LAYERS);
  try {
    const saved = JSON.parse(localStorage.getItem('seed-scout-layers')) || {};
    for (const name of Object.keys(DEFAULT_LAYERS)) if (typeof saved[name] === typeof DEFAULT_LAYERS[name]) layers[name] = saved[name];
  } catch { }

  let result = null, host = null, canvas = null, ctx = null, ratio = 1, width = 0, height = 0, centre = { x: 0, z: 0 }, bpp = 4;
  let active = 0, featureActive = 0, frame = 0, anim = 0, legendTimer = 0, clickToken = 0, drawn = 0;
  let selection = null, hover = null, drag = null, pinch = null, measure = null, pendingFit = false;
  let markerList = [], matchMarkers = [], markersDirty = true, featureCache = null, statsKey = '';
  const pointers = new Map(), cache = new Map(), pending = new Set(), failed = new Map(), tileStreams = new Map();
  let terrainView = '', terrainTiles = [], previewTiles = [], terrainTimer = 0, terrainAfter = 0, terrainRetry = 0;
  let supportsTileStream = true;
  const featureTiles = new Map(), featurePending = new Set(), featureFailed = new Map();
  const pins = new Map(), listeners = {}, paths = new Map(), slime = new Map();

  const on = (name, fn) => { (listeners[name] ||= []).push(fn); };
  const emit = (name, data) => { for (const fn of listeners[name] || []) fn(data); };
  const clampBpp = v => Math.max(MIN_BPP, Math.min(MAX_BPP, v));
  const screen = (x, z) => ({ x: width / 2 + (x - centre.x) / bpp, y: height / 2 + (z - centre.z) / bpp });
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const bounds = () => ({ left: centre.x - width * bpp / 2, top: centre.z - height * bpp / 2, right: centre.x + width * bpp / 2, bottom: centre.z + height * bpp / 2 });
  const zoomLevel = (value = bpp) => Math.max(1, ZOOM_STOPS.filter(stop => stop >= value).length);

  // ---- Terrain tiles -----------------------------------------------------
  // Full terrain columns cost about 0.2 ms each, so they are only used up to 16 blocks per sample.
  // Wider views use the engine's quick biome map instead, and the sample spacing always follows the zoom:
  // a view needs the same few hundred tiles however far out it is.
  const MAX_TERRAIN_STEP = 16, MAX_STEP = 128, STEPS = [1, 2, 4, 8, 16, 32, 64, 128];
  const modeFor = step => step > MAX_TERRAIN_STEP ? 'quick' : 'terrain';
  // Screen pixels per sample: 2 to 4 for "sharp", 4 to 8 for "fast", which needs about a quarter of the tiles.
  let detail = 2;
  try { if (localStorage.getItem('seed-scout-map-detail') === 'fast') detail = 4; } catch { }
  function terrainStep() {
    const step = Math.max(1, Math.min(MAX_STEP, 2 ** Math.ceil(Math.log2(bpp * detail))));
    // Whatever the detail, views up to 8 blocks per pixel stay real terrain rather than the overview.
    return bpp <= MAX_TERRAIN_STEP / 2 ? Math.min(MAX_TERRAIN_STEP, step) : step;
  }
  function setDetail(name) {
    detail = name === 'fast' ? 4 : 2;
    try { localStorage.setItem('seed-scout-map-detail', name === 'fast' ? 'fast' : 'sharp'); } catch { }
    terrainView = ''; invalidate(); queueLegend();
  }
  function tilesFor(step, mode = modeFor(step)) {
    if (!result || !width) return [];
    const span = step * 32, offset = terrain.sampleOffset(step), view = bounds(), tiles = [];
    for (let z = Math.floor((view.top - offset) / span) * span; z + offset < view.bottom; z += span)
      for (let x = Math.floor((view.left - offset) / span) * span; x + offset < view.right; x += span) {
        if (Math.abs(x) > 29990000 || Math.abs(z) > 29990000) continue;
        tiles.push({ seed: result.seed, x, z, step, mode, key: tileKey(result.seed, x, z, step, mode), distance: Math.hypot(x + offset + span / 2 - centre.x, z + offset + span / 2 - centre.z) });
      }
    return tiles.sort((a, b) => a.distance - b.distance);
  }
  function wanted() {
    const step = terrainStep();
    const view = `${result?.seed}:${centre.x}:${centre.z}:${bpp}:${width}:${height}`;
    if (view !== terrainView) {
      terrainView = view; terrainTiles = tilesFor(step);
      // Biome first: a terrain view starts as the quick biome map at a quarter of its resolution, which is a
      // sixteenth of the tiles and arrives in about a tenth of a second; terrain then fills in on top of it.
      previewTiles = modeFor(step) === 'terrain' ? tilesFor(step * 4, 'quick') : [];
    }
    const missing = terrainTiles.some(t => !cache.has(t.key));
    const preview = missing ? previewTiles.filter(t => !cache.has(t.key) && (failed.get(t.key) || 0) <= Date.now()) : [];
    return { fine: terrainTiles, queue: preview.length ? preview : terrainTiles };
  }
  function pump() {
    if (!result || !width) return;
    // During a pan/zoom burst, draw cached tiles immediately and wait briefly for the view to settle.
    if (Date.now() < terrainAfter) {
      clearTimeout(terrainTimer); terrainTimer = setTimeout(pump, terrainAfter - Date.now()); return;
    }
    const { fine, queue } = wanted();
    const relevant = new Set([...fine, ...previewTiles].map(t => t.key));
    for (const [controller, tiles] of tileStreams) if (tiles.every(t => !relevant.has(t.key))) controller.abort();
    const todo = queue.filter(t => !cache.has(t.key) && !pending.has(t.key) && (failed.get(t.key) || 0) <= Date.now());
    // Keep a small amount of work ahead of the native workers. Deeper queues increase the cost of
    // panning away: native columns already running finish even after their stream is abandoned.
    const batch = todo[0]?.mode === 'quick' ? 12 : Math.min(16, Math.max(1, Math.ceil((catalog?.mapWorkers || 2) * 1.5 / TILE_REQUESTS)));
    while (active < TILE_REQUESTS && todo.length) {
      const tiles = todo.splice(0, batch), { seed, step, mode } = tiles[0], controller = new AbortController();
      active++; tileStreams.set(controller, tiles); for (const tile of tiles) pending.add(tile.key);
      const receive = record => {
        const tile = tiles[record.index];
        if (!tile || !pending.has(tile.key)) throw new Error('Invalid tile response');
        if (record.error) throw new Error(record.error);
        const data = record.tile;
        if (!data || tileKey(data.seed, data.x, data.z, data.step, data.mode) !== tile.key) throw new Error('Unexpected tile response');
        cache.set(tile.key, { data, image: null, style: '' });
        // Neighbours were drawn without this tile's edge samples.
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const near = (dx || dz) && cache.get(tileKey(tile.seed, tile.x + dx * tile.step * 32, tile.z + dz * tile.step * 32, tile.step, tile.mode));
          if (near) near.style = '';
        }
        const budget = Math.max(CACHE_SIZE, wanted().fine.length + previewTiles.length);
        while (cache.size > budget) cache.delete(cache.keys().next().value);
      };
      const query = new URLSearchParams({ v: `4-${catalog?.version || ''}`, seed, step, mode, at: tiles.map(t => `${t.x},${t.z}`).join(';') });
      const streaming = supportsTileStream;
      fetch(`/api/${streaming ? 'tile-stream' : 'tiles'}?${query}`, { signal: controller.signal })
        .then(async response => {
          // A page can be refreshed after an update while the previous local engine is still running.
          // Keep that combination usable until the app is restarted.
          let stream = streaming;
          if (stream && response.status === 404) {
            supportsTileStream = stream = false;
            response = await fetch(`/api/tiles?${query}`, { signal: controller.signal });
          }
          if (!response.ok) throw new Error((await response.json()).error || 'Tile request failed');
          if (!stream) { (await response.json()).tiles.forEach((tile, index) => receive({ tile, index })); return; }
          const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
          try {
            while (true) {
              const { value, done } = await reader.read();
              buffer += decoder.decode(value, { stream: !done });
              let end;
              while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line) receive(JSON.parse(line)); }
              invalidate(); pump();
              if (done) break;
            }
            if (buffer.trim() || tiles.some(t => !cache.has(t.key))) throw new Error('Incomplete tile response');
          } finally { reader.releaseLock(); }
        })
        .catch(e => {
          controller.abort();
          if (e.name === 'AbortError') return;
          for (const tile of tiles) if (!cache.has(tile.key)) failed.set(tile.key, Date.now() + 10000);
          if (!terrainRetry) terrainRetry = setTimeout(() => { terrainRetry = 0; pump(); }, 10050);
          if (result?.seed === seed) $('status-tiles').textContent = `Map tile failed: ${e.message}`;
        })
        .finally(() => { active--; tileStreams.delete(controller); for (const tile of tiles) pending.delete(tile.key); invalidate(); pump(); queueLegend(); });
    }
    const loaded = fine.filter(t => cache.has(t.key)).length, done = loaded === fine.length;
    const step = fine[0]?.step || 0, quality = modeFor(step) === 'quick' ? 'Biome overview' : 'Base terrain';
    $('status-tiles').textContent = done ? `${quality} · ${step} block${step === 1 ? '' : 's'} per sample` : `${quality} · loading ${loaded}/${fine.length}`;
    $('tile-progress').hidden = done;
    $('tile-progress').firstElementChild.style.width = `${fine.length ? loaded / fine.length * 100 : 0}%`;
    pumpFeatures();
  }
  // terrain.js asks for a tile's neighbours so shading and contours line up across tile edges.
  const around = d => (dx, dz) => cache.get(tileKey(d.seed, d.x + dx * d.step * 32, d.z + dz * d.step * 32, d.step, d.mode))?.data || null;
  function sample(x, z) {
    if (!result) return null;
    let best = null, i = 0;
    for (const step of STEPS) {
      const cell = terrain.cell(x, z, step);
      best = cache.get(tileKey(result.seed, cell.x, cell.z, step, modeFor(step)))?.data;
      if (best) { i = cell.index; break; }
    }
    if (!best) return null;
    // Quick tiles only estimate the height, which the status bar marks as approximate.
    return { biome: best.palette[best.biomes[i]], y: best.elevation[i], water: best.water[i], exact: best.mode === 'terrain' };
  }

  // ---- Slime chunks: java.util.Random seeded the way WorldgenRandom.seedSlimeChunk does ----
  function isSlime(cx, cz) {
    let chunks = slime.get(result.seed);
    if (!chunks) { slime.clear(); slime.set(result.seed, chunks = new Map()); }
    const id = `${cx},${cz}`;
    let value = chunks.get(id);
    if (value === undefined) {
      const mask = (1n << 48n) - 1n;
      const mixed = BigInt(result.seed) + BigInt(Math.imul(Math.imul(cx, cx), 4987142)) + BigInt(Math.imul(cx, 5947611)) + BigInt(Math.imul(cz, cz)) * 4392871n + BigInt(Math.imul(cz, 389711)) ^ 987234911n;
      let state = (mixed ^ 0x5DEECE66Dn) & mask, bits, rem;
      do { state = (state * 0x5DEECE66Dn + 0xBn) & mask; bits = Number(state >> 17n); rem = bits % 10; } while (bits - rem + 9 > 2147483647);
      if (chunks.size > 120000) chunks.clear();
      chunks.set(id, value = rem === 0);
    }
    return value;
  }

  // ---- Structure layers --------------------------------------------------
  // Every structure type is a layer. Its markers are fetched per square "feature tile" for whatever is in view;
  // the tile size follows the layer's zoom stop, so a layer never needs more than a dozen tiles on screen.
  const defaultFeature = key => ({ on: true, from: (FEATURE_DEFAULTS.find(d => d[0] === key) || [key, 8])[1] });
  function features() {
    if (featureCache) return featureCache;
    const ranked = FEATURE_DEFAULTS.map(d => d[0]), known = catalog ? catalog.sets.filter(k => !k.includes('__') && !/^(huge_)?ruined_portals_/.test(k) && !catalog.dimensions?.[k]) : ranked;
    const order = [...ranked.filter(k => known.includes(k)), ...known.filter(k => !ranked.includes(k)).sort()];
    const list = order.map((key, rank) => ({ key, rank, ...defaultFeature(key), ...layers.features[key] }));
    if (catalog) featureCache = list;
    return list;
  }
  const tileSize = from => Math.max(1024, Math.min(32768, from * 512));
  const markerId = f => `${f.kind}:${f.portalSize ? 'ruined_portals' : f.key}:${f.x}:${f.z}`;
  // Small tiles can share the any-size portal data. Wide giant-only tiles need their own
  // request so the common portal marker limit cannot hide rare giant portals.
  const featureRequestKey = (key, size) => key === 'huge_ruined_portals' && size <= 8192 ? 'ruined_portals' : key;
  function featureTilesInView(feature) {
    const size = tileSize(feature.from), view = bounds(), tiles = [];
    for (let z = Math.floor(view.top / size) * size; z < view.bottom; z += size)
      for (let x = Math.floor(view.left / size) * size; x < view.right; x += size)
        if (Math.abs(x) <= LIMIT - size && Math.abs(z) <= LIMIT - size) tiles.push({ size, x, z, id: `${result.seed}:${featureRequestKey(feature.key, size)}:${size}:${x}:${z}` });
    return tiles;
  }
  const featureShown = f => layers.structures && f.on && bpp <= f.from;
  const variantShown = (feature, marker) => (feature.key !== 'huge_ruined_portals' || marker.portalSize === 'huge') &&
    (!Array.isArray(feature.variants) || feature.variants.includes(marker.detail)) &&
    (!Array.isArray(feature.placements) || feature.placements.includes(marker.placement)) &&
    (!Array.isArray(feature.templates) || feature.templates.includes(marker.shipwreckTemplate));
  function pumpFeatures() {
    if (!result || !width || !catalog) return;
    // One request per layer and tile: a slow type (ocean monuments, ruined portals) must not hold up the quick ones.
    // The most important layers go first, nearest tile first, three at a time: the other connections carry terrain.
    const queue = [], now = Date.now();
    for (const feature of features()) if (featureShown(feature)) for (const tile of featureTilesInView(feature)) {
      if (featureTiles.has(tile.id) || featurePending.has(tile.id) || (featureFailed.get(tile.id) || 0) > now) continue;
      queue.push({ ...tile, key: feature.key, rank: feature.rank, distance: Math.hypot(tile.x + tile.size / 2 - centre.x, tile.z + tile.size / 2 - centre.z) });
    }
    queue.sort((a, b) => a.rank - b.rank || a.distance - b.distance);
    for (const job of queue) {
      if (featurePending.has(job.id)) continue;
      if (featureActive >= 3) break;
      featureActive++; featurePending.add(job.id);
      const requestKey = featureRequestKey(job.key, job.size);
      api('/api/structures', { seed: result.seed, x: job.x, z: job.z, size: job.size, keys: [requestKey] })
        .then(response => {
          featureTiles.set(job.id, { limited: (response.limited || []).includes(requestKey), features: response.features.map(f => ({ ...f, id: markerId(f), source: 'auto', rank: job.rank })) });
          while (featureTiles.size > FEATURE_CACHE) featureTiles.delete(featureTiles.keys().next().value);
        })
        .catch(() => featureFailed.set(job.id, Date.now() + 15000))
        .finally(() => { featureActive--; featurePending.delete(job.id); markersDirty = true; invalidate(); pumpFeatures(); });
    }
  }
  // Gather the markers for the current view and decide which ones get a full icon.
  // More important markers claim their spot first; a lesser marker that would overlap one becomes a small dot.
  function collect() {
    markersDirty = false;
    if (!result) { markerList = []; return; }
    const view = bounds(), margin = 30 * bpp, seen = new Set(), stats = {};
    let gathered = [];
    const add = marker => { if (!seen.has(marker.id)) { seen.add(marker.id); gathered.push(marker.portalSize === 'huge' ? { ...marker, key: 'huge_ruined_portals' } : marker); } };
    if (selection?.marker) add(selection.marker);
    if (layers.matches) matchMarkers.forEach(add);
    (pins.get(result.seed) || []).forEach(add);
    for (const feature of features()) {
      const state = stats[feature.key] = { shown: featureShown(feature), count: 0, limited: false, loading: false };
      if (!state.shown) continue;
      for (const tile of featureTilesInView(feature)) {
        const entry = featureTiles.get(tile.id);
        if (!entry) { state.loading = true; continue; }
        state.limited ||= entry.limited;
        for (const marker of entry.features) if (variantShown(feature, marker) && marker.x > view.left - margin && marker.x < view.right + margin && marker.z > view.top - margin && marker.z < view.bottom + margin) { state.count++; add(marker); }
      }
    }
    // Markers of one type that would sit on top of each other become a single marker with a count.
    // Matches, pins and the selection always stand alone. Clicking a cluster zooms in on it.
    const reach = 26, groups = new Map(), merged = [];
    for (const marker of gathered) {
      if (marker.source !== 'auto' || selection?.marker?.id === marker.id) { merged.push(marker); continue; }
      const p = screen(marker.x, marker.z), id = `${marker.key}:${Math.floor(p.x / reach)}:${Math.floor(p.y / reach)}`;
      let group = groups.get(id);
      if (!group) { groups.set(id, group = { id, members: [] }); merged.push(group); }
      group.members.push(marker);
    }
    gathered = merged.map(g => !g.members ? g : g.members.length === 1 ? g.members[0] : {
      ...g.members[0], id: `cluster:${g.id}`, cluster: g.members.length,
      x: Math.round(g.members.reduce((sum, m) => sum + m.x, 0) / g.members.length), z: Math.round(g.members.reduce((sum, m) => sum + m.z, 0) / g.members.length),
    });
    const weight = m => (selection?.marker?.id === m.id ? -100 : 0) + m.rank;
    gathered.sort((a, b) => weight(a) - weight(b));
    const cells = new Map(), spacing = 24;
    for (const marker of gathered) {
      const p = screen(marker.x, marker.z), cx = Math.floor(p.x / spacing), cy = Math.floor(p.y / spacing);
      let clash = false;
      for (let dy = -1; dy <= 1 && !clash; dy++) for (let dx = -1; dx <= 1 && !clash; dx++)
        for (const other of cells.get((cx + dx) * 100003 + cy + dy) || []) if (Math.hypot(other.x - p.x, other.y - p.y) < spacing) { clash = true; break; }
      marker.dot = clash && marker.source === 'auto' && selection?.marker?.id !== marker.id;
      if (!marker.dot) { const cell = cx * 100003 + cy; if (!cells.has(cell)) cells.set(cell, []); cells.get(cell).push(p); }
    }
    markerList = gathered.reverse();
    const key = JSON.stringify(stats);
    if (key !== statsKey) { statsKey = key; emit('features', stats); }
  }
  const markerRadius = () => bpp <= 8 ? 11 : 9;
  function markerAt(px, py) {
    let best = null, bestDistance = Infinity;
    for (const m of markerList) {
      const p = screen(m.x, m.z), d = Math.hypot(p.x - px, p.y - py), reach = m.dot ? 7 : markerRadius() + 4;
      // A full marker wins over a dot underneath the pointer.
      if (d < reach && d - (m.dot ? 0 : 20) < bestDistance) { best = m; bestDistance = d - (m.dot ? 0 : 20); }
    }
    return best;
  }
  function glyph(name, x, y, size, colour, fill) {
    let path = paths.get(name);
    if (!path) paths.set(name, path = new Path2D(ICONS[name] || ICONS.pin));
    ctx.save(); ctx.translate(x - size / 2, y - size / 2); ctx.scale(size / 24, size / 24);
    ctx.lineCap = ctx.lineJoin = 'round';
    if (fill) { ctx.fillStyle = fill; ctx.fill(path); }
    ctx.lineWidth = 2.1; ctx.strokeStyle = colour; ctx.stroke(path);
    ctx.restore();
  }
  function caption(text, x, y) {
    ctx.font = '600 11px system-ui, "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.lineJoin = 'round'; ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(8,12,14,.86)'; ctx.strokeText(text, x, y);
    ctx.fillStyle = '#fff'; ctx.fillText(text, x, y);
  }

  // ---- Drawing -----------------------------------------------------------
  function invalidate() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; if (markersDirty) collect(); draw(); chrome(); pump(); });
  }
  function draw() {
    if (!ctx || !result) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#0b1012'; ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = false;

    // Coarse cached tiles stay visible while finer tiles arrive, and are painted underneath them.
    // Tiles of the view's own kind (terrain or quick overview) go on top, so a finished view is all of one kind.
    const style = terrain.styleKey(layers), tiles = [], mode = modeFor(terrainStep());
    for (const t of cache.values()) {
      if (t.data.seed !== result.seed) continue;
      const extent = terrain.placement(t.data), size = extent.span / bpp, p = screen(extent.x, extent.z);
      // Tiles from a much closer zoom are specks at this one.
      if (size < 16 || p.x > width || p.y > height || p.x + size < 0 || p.y + size < 0) continue;
      tiles.push({ t, p, size });
    }
    tiles.sort((a, b) => (a.t.data.mode === mode) - (b.t.data.mode === mode) || b.t.data.step - a.t.data.step);
    drawn++;
    for (const { t, p, size } of tiles) {
      const rasterSize = Math.max(32, Math.ceil(size / 32) * 32), tileStyle = `${style}:${rasterSize}`;
      if (t.style !== tileStyle) { t.image = terrain.raster(t.data, layers, around(t.data), rasterSize); t.style = tileStyle; }
      t.used = drawn;
      const key = tileKey(t.data.seed, t.data.x, t.data.z, t.data.step, t.data.mode);
      cache.delete(key); cache.set(key, t); // Retain visible tiles in the bounded LRU cache.
      terrain.drawRaster(ctx, t.image, t.data, p.x, p.y, size, ratio);
      terrain.overlay(ctx, t.data, layers, around(t.data), p.x, p.y, size);
    }
    // Shaded tile images are far larger than the tile data, so drop the ones that have been off screen for a while.
    if (drawn % 120 === 0) for (const t of cache.values()) if (t.image && t.used < drawn - 240) { t.image = null; t.style = ''; }

    const view = bounds(), chunkPx = 16 / bpp;
    if (layers.slime && chunkPx >= 5) {
      ctx.fillStyle = 'rgba(126,232,96,.34)'; ctx.strokeStyle = 'rgba(190,255,170,.75)'; ctx.lineWidth = 1;
      for (let cz = Math.floor(view.top / 16); cz * 16 < view.bottom; cz++) for (let cx = Math.floor(view.left / 16); cx * 16 < view.right; cx++) {
        if (!isSlime(cx, cz)) continue;
        const p = screen(cx * 16, cz * 16);
        ctx.fillRect(p.x, p.y, chunkPx, chunkPx); ctx.strokeRect(p.x + .5, p.y + .5, chunkPx - 1, chunkPx - 1);
      }
    }
    if (layers.grid || bpp <= .125) {
      const spacing = bpp <= .125 ? 1 : [16, 512, 8192, 131072].find(s => s / bpp >= 9) || 131072;
      const line = (value, vertical, colour) => {
        const p = screen(value, value); ctx.strokeStyle = colour; ctx.beginPath();
        if (vertical) { ctx.moveTo(Math.round(p.x) + .5, 0); ctx.lineTo(Math.round(p.x) + .5, height); } else { ctx.moveTo(0, Math.round(p.y) + .5); ctx.lineTo(width, Math.round(p.y) + .5); }
        ctx.stroke();
      };
      ctx.lineWidth = 1;
      const major = spacing === 16 ? 512 : spacing * 16;
      const shade = v => v === 0 ? 'rgba(255,216,102,.8)' : v % major === 0 ? 'rgba(255,255,255,.3)' : 'rgba(255,255,255,.1)';
      for (let x = Math.floor(view.left / spacing) * spacing; x < view.right; x += spacing) line(x, true, shade(x));
      for (let z = Math.floor(view.top / spacing) * spacing; z < view.bottom; z += spacing) line(z, false, shade(z));
    }

    if (selection) {
      if (selection.box) {
        // Footprint of the built structure.
        const a = screen(selection.box.minX, selection.box.minZ), b = screen(selection.box.maxX + 1, selection.box.maxZ + 1);
        ctx.fillStyle = 'rgba(255,216,102,.16)'; ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
        ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffd866'; ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      } else {
        const size = 1 / bpp, p = screen(selection.x, selection.z);
        // Exactly one block at close zoom; a small crosshair keeps the location visible in wide views.
        if (size < 4) {
          const x = p.x + size / 2, y = p.y + size / 2;
          ctx.beginPath(); ctx.moveTo(x - 5, y); ctx.lineTo(x + 5, y); ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5);
          ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,12,14,.7)'; ctx.stroke();
          ctx.lineWidth = 1; ctx.strokeStyle = '#ffd866'; ctx.stroke();
        } else {
          ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(8,12,14,.55)'; ctx.strokeRect(p.x, p.y, size, size);
          ctx.lineWidth = 2; ctx.strokeStyle = '#ffd866'; ctx.strokeRect(p.x, p.y, size, size);
        }
      }
    }

    // A match that was measured from another match is tied to it.
    if (layers.matches) for (const m of matchMarkers) if (m.near) {
      const a = screen(m.x, m.z), b = screen(m.near.x, m.near.z);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.setLineDash([]); ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(8,12,14,.45)'; ctx.stroke();
      ctx.setLineDash([5, 5]); ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.stroke(); ctx.setLineDash([]);
    }
    const r = markerRadius(), full = markerList.filter(m => !m.dot);
    for (const m of markerList) if (m.dot) {
      const p = screen(m.x, m.z);
      ctx.beginPath(); ctx.arc(p.x, p.y, m === hover ? 5 : 3.5, 0, Math.PI * 2); ctx.fillStyle = featureStyle(m.kind, m.key).colour; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(8,12,14,.8)'; ctx.stroke();
    }
    // Naming every marker only reads well up close; further out, names go to matches, pins and the selection.
    const labelled = layers.labels && bpp <= 2 && full.length <= 40;
    for (const m of full) {
      const p = screen(m.x, m.z), look = featureStyle(m.kind, m.key), selected = selection?.marker?.id === m.id, pinned = m.source !== 'auto', big = selected || m === hover ? r + 2 : r;
      if (selected) { ctx.beginPath(); ctx.arc(p.x, p.y, big + 5, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,216,102,.35)'; ctx.fill(); }
      ctx.beginPath(); ctx.arc(p.x, p.y, big + 1.5, 0, Math.PI * 2); ctx.fillStyle = 'rgba(8,12,14,.55)'; ctx.fill();
      ctx.beginPath(); ctx.arc(p.x, p.y, big, 0, Math.PI * 2); ctx.fillStyle = look.colour; ctx.fill();
      ctx.lineWidth = pinned ? 2.5 : 1.5; ctx.strokeStyle = pinned ? '#fff' : 'rgba(255,255,255,.75)'; ctx.stroke();
      glyph(look.icon, p.x, p.y, big * 1.36, '#10181b');
      if (m.cluster) {
        const text = m.cluster > 99 ? '99+' : String(m.cluster), bx = p.x + big * .78, by = p.y - big * .78;
        ctx.font = '700 9px system-ui, "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const half = Math.max(7, ctx.measureText(text).width / 2 + 4);
        ctx.beginPath(); ctx.roundRect(bx - half, by - 7, half * 2, 14, 7); ctx.fillStyle = '#10181b'; ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.fillText(text, bx, by + .5);
      }
      if (labelled || (layers.labels && (selected || pinned) && bpp <= 16)) caption(label(m.key), p.x, p.y + big + 4);
    }

    // Keep overlapping spawn and feature markers separate; the leader marks the true spawn.
    if (layers.spawn) {
      const anchor = screen(result.spawnX, result.spawnZ);
      const occupied = markerList.map(m => {
        const p = screen(m.x, m.z);
        const hasLabel = !m.dot && (labelled || (layers.labels && (selection?.marker?.id === m.id || m.source !== 'auto') && bpp <= 16));
        return { ...p, radius: m.dot ? 7 : r + 6, label: hasLabel ? label(m.key) : '' };
      });
      const clearance = p => occupied.reduce((gap, m) => {
        const iconGap = Math.hypot(p.x - m.x, p.y - m.y) - m.radius - 21;
        // Leave room for the feature's caption as well as its icon.
        const labelGap = m.label ? Math.hypot(Math.max(0, Math.abs(p.x - m.x) - ctx.measureText(m.label).width / 2), p.y - (m.y + r + 10)) - 25 : Infinity;
        return Math.min(gap, iconGap, labelGap);
      }, Infinity);
      let p = anchor;
      if (clearance(anchor) < 0) {
        let bestGap = -Infinity;
        const offsets = [[0, -1], [1, 0], [-1, 0], [0, 1], [1, -1], [-1, -1], [1, 1], [-1, 1]];
        for (const distance of [48, 72, 96]) {
          for (const [dx, dy] of offsets) {
            const candidate = { x: anchor.x + dx * distance, y: anchor.y + dy * distance };
            if (candidate.x < 21 || candidate.x > width - 21 || candidate.y < 21 || candidate.y > height - 36) continue;
            const gap = clearance(candidate);
            if (gap > bestGap) { p = candidate; bestGap = gap; }
            if (gap >= 0) break;
          }
          if (bestGap >= 0) break;
        }
      }
      if (p !== anchor) {
        const distance = Math.hypot(p.x - anchor.x, p.y - anchor.y);
        ctx.beginPath(); ctx.moveTo(anchor.x, anchor.y);
        ctx.lineTo(p.x - (p.x - anchor.x) * 17 / distance, p.y - (p.y - anchor.y) * 17 / distance);
        ctx.lineWidth = 4; ctx.strokeStyle = '#1a1408'; ctx.stroke();
        ctx.lineWidth = 2; ctx.strokeStyle = '#f6c95f'; ctx.stroke();
        ctx.beginPath(); ctx.arc(anchor.x, anchor.y, 3, 0, Math.PI * 2); ctx.fillStyle = '#f6c95f'; ctx.fill();
      }
      ctx.beginPath(); ctx.arc(p.x, p.y, 17, 0, Math.PI * 2); ctx.fillStyle = '#1a1408'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#f6c95f'; ctx.stroke();
      glyph('home', p.x, p.y, 26, '#f6c95f');
      if (layers.labels && bpp <= 6) caption('Spawn', p.x, p.y + 19);
    }

    if (measure?.a) {
      const a = screen(measure.a.x, measure.a.z), end = measure.b || measure.cursor;
      if (end) {
        const b = screen(end.x, end.z);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(8,12,14,.6)'; ctx.stroke();
        ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.setLineDash(measure.b ? [] : [6, 5]); ctx.stroke(); ctx.setLineDash([]);
        caption(`${fmt(Math.round(Math.hypot(end.x - measure.a.x, end.z - measure.a.z)))} blocks`, (a.x + b.x) / 2, (a.y + b.y) / 2 + 8);
        ctx.beginPath(); ctx.arc(b.x, b.y, 4.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#10181b'; ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(a.x, a.y, 4.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#10181b'; ctx.stroke();
    }
  }
  // Scale bar, zoom read-out and the throttled view event.
  function chrome() {
    if (!result) return;
    const target = bpp * 120, magnitude = 10 ** Math.floor(Math.log10(target)), blocks = [5, 2, 1].map(n => n * magnitude).find(n => n <= target) || magnitude;
    $('scale-line').style.width = `${blocks / bpp}px`;
    $('scale-text').textContent = `${fmt(blocks)} block${blocks === 1 ? '' : 's'}`;
    $('status-zoom').textContent = `Z${zoomLevel()} · ${bpp >= 1 ? `1 px = ${+bpp.toFixed(bpp < 10 ? 1 : 0)} blocks` : `1 block = ${+(1 / bpp).toFixed(1)} px`}`;
    emit('view', { x: centre.x, z: centre.z, bpp, level: zoomLevel() });
  }
  function queueLegend() {
    clearTimeout(legendTimer);
    legendTimer = setTimeout(() => {
      if (!result) return;
      const counts = new Map(), view = bounds(); let total = 0;
      for (const t of wanted().fine) {
        const d = cache.get(t.key)?.data; if (!d) continue;
        const c0 = Math.max(0, Math.floor((view.left - d.x) / d.step)), c1 = Math.min(31, Math.floor((view.right - d.x) / d.step));
        const r0 = Math.max(0, Math.floor((view.top - d.z) / d.step)), r1 = Math.min(31, Math.floor((view.bottom - d.z) / d.step));
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const name = d.palette[d.biomes[r * 32 + c]]; counts.set(name, (counts.get(name) || 0) + 1); total++; }
      }
      emit('legend', { basemap: layers.basemap, biomes: [...counts].sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, share: n / total })) });
    }, 350);
  }

  // ---- View --------------------------------------------------------------
  function update() {
    centre.x = Math.max(-LIMIT, Math.min(LIMIT, centre.x)); centre.z = Math.max(-LIMIT, Math.min(LIMIT, centre.z));
    terrainAfter = Date.now() + 90;
    markersDirty = true; invalidate(); queueLegend(); pump();
  }
  function flyTo(x, z, targetBpp = bpp) {
    cancelAnimationFrame(anim); targetBpp = clampBpp(targetBpp);
    const from = { x: centre.x, z: centre.z, bpp }, pixels = Math.hypot(x - from.x, z - from.z) / Math.max(bpp, targetBpp);
    if (!width || reducedMotion() || pixels > Math.max(width, height) * 2.5) { centre = { x, z }; bpp = targetBpp; update(); return; }
    const began = performance.now();
    const step = now => {
      const t = Math.min(1, (now - began) / 340), k = 1 - (1 - t) ** 3;
      centre = { x: from.x + (x - from.x) * k, z: from.z + (z - from.z) * k }; bpp = from.bpp * (targetBpp / from.bpp) ** k;
      if (t < 1) { draw(); chrome(); anim = requestAnimationFrame(step); } else update();
    };
    anim = requestAnimationFrame(step);
  }
  function zoomAt(clientX, clientY, factor) {
    const rect = canvas.getBoundingClientRect(), dx = clientX - rect.left - width / 2, dz = clientY - rect.top - height / 2, old = bpp;
    bpp = clampBpp(bpp * factor); centre.x += dx * (old - bpp); centre.z += dz * (old - bpp); update();
  }
  const zoomBy = factor => flyTo(centre.x, centre.z, bpp * factor);
  // Go straight to a stored view (a saved seed), instead of framing the search matches.
  function jump(x, z, zoom) { pendingFit = false; cancelAnimationFrame(anim); centre = { x, z }; bpp = clampBpp(zoom || bpp); update(); }
  const home = () => result && flyTo(result.spawnX, result.spawnZ, Math.min(bpp, HOME_BPP));
  function fit(animate = true) {
    if (!result || !width || !height) return;
    const points = [{ x: result.spawnX, z: result.spawnZ }, { x: result.anchorX, z: result.anchorZ }, ...matchMarkers, ...(pins.get(result.seed) || [])];
    const xs = points.map(p => p.x), zs = points.map(p => p.z), minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const target = clampBpp(Math.max(HOME_BPP, (maxX - minX) / (width * .62), (maxZ - minZ) / (height * .62)));
    if (animate) flyTo((minX + maxX) / 2, (minZ + maxZ) / 2, target); else { centre = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 }; bpp = target; update(); }
  }
  function resize() {
    if (!canvas) return;
    width = host.clientWidth; height = host.clientHeight; ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    ctx = canvas.getContext('2d');
    // A seed can open before the stage has a size (background tab); frame it once it does.
    if (pendingFit && width && height) { pendingFit = false; fit(false); }
    markersDirty = true; draw(); invalidate();
  }

  // ---- Pointer, hover and inspector --------------------------------------
  function locate(event) {
    const rect = canvas.getBoundingClientRect();
    const worldX = centre.x + (event.clientX - rect.left - width / 2) * bpp, worldZ = centre.z + (event.clientY - rect.top - height / 2) * bpp;
    return { x: Math.floor(worldX), z: Math.floor(worldZ), worldX, worldZ, px: event.clientX - rect.left, py: event.clientY - rect.top };
  }
  function describe(event) {
    const at = locate(event), info = sample(at.worldX, at.worldZ), marker = drag?.moved ? null : markerAt(at.px, at.py);
    $('status-cursor').innerHTML = `<b>X</b> ${at.x} <b>Z</b> ${at.z}<span><b>Chunk</b> ${Math.floor(at.x / 16)}, ${Math.floor(at.z / 16)}</span>${info ? `<span><i class="swatch" style="background:${terrain.colour(info.biome)}"></i>${esc(label(info.biome))}</span><span><b>Y</b> ${info.exact ? '' : '≈ '}${info.y}${info.water ? ' · water' : ''}</span>` : ''}`;
    if (measure) { measure.cursor = at; measureText(); invalidate(); }
    if (marker !== hover) { hover = marker; invalidate(); }
    const tip = $('map-tip');
    tip.hidden = !marker || !!measure;
    canvas.classList.toggle('pointing', !!marker && !measure);
    if (marker && !measure) {
      const p = screen(marker.x, marker.z);
      tip.innerHTML = marker.cluster ? `<b>${marker.cluster} × ${esc(label(marker.key))}</b><span>Click to zoom in</span>` : `<b>${esc(label(marker.key))}</b><span>X ${marker.x} · Z ${marker.z}</span>`;
      tip.style.left = `${p.x}px`; tip.style.top = `${p.y - (marker.dot ? 5 : markerRadius()) - 10}px`;
    }
  }
  function closeInspector() { selection = null; clickToken++; $('inspector').hidden = true; markersDirty = true; invalidate(); }
  async function inspect(location, marker, nudge = false) {
    const seed = result.seed, token = ++clickToken, box = $('inspector'), look = marker ? featureStyle(marker.kind, marker.key) : { icon: 'pin', colour: '#ffd866' };
    selection = { x: location.x, z: location.z, marker }; markersDirty = true; invalidate();
    const variant = marker && !/\s/.test(marker.detail || '') ? label(marker.detail || marker.key) : '';
    const note = !marker ? 'Selected block' : [marker.kind === 'biome' ? 'Biome match' : variant, marker.source === 'match' ? 'search match' : marker.source === 'pin' ? 'pinned' : ''].filter(Boolean).join(' · ');
    const head = `<header><span class="glyph" style="--c:${look.colour}">${icon(look.icon)}</span><div><h4>${marker ? esc(label(marker.key)) : 'Location'}</h4><p>${esc(note)}</p></div><button class="icon-btn" id="info-close" aria-label="Close details">${icon('x')}</button></header>`;
    box.hidden = false; box.innerHTML = `${head}<p class="hint">Reading the block…</p>`;
    $('info-close').onclick = closeInspector;
    // Slide the map over if the clicked point would sit underneath the inspector card.
    const at = screen(location.x, location.z), clear = width - box.offsetWidth - 60;
    if (nudge && width > 700 && at.x > clear && at.y < 420) flyTo(centre.x + (at.x - clear) * bpp, centre.z);
    try {
      // Markers on the map come from the quick generation-point check; clicking one builds the structure to confirm it.
      const [p, built] = await Promise.all([
        api('/api/point', { seed, x: location.x, z: location.z }),
        marker?.kind === 'structure' ? api('/api/structure', { seed, key: marker.key, x: marker.at?.x ?? marker.x, z: marker.at?.z ?? marker.z }).catch(() => null) : null,
      ]);
      if (result?.seed !== seed || token !== clickToken) return;
      const fact = (name, value) => `<div><dt>${name}</dt><dd>${value}</dd></div>`, shape = built?.valid && (built.shipBox || built.box);
      if (shape) { selection.box = shape; invalidate(); }
      const confidence = !marker ? '' : built?.valid ? built.confidence : built ? '' : marker.confidence;
      // A built structure comes with a block to stand in beside or inside it; anywhere else it is the block above the surface.
      // A marker from another dimension shows that dimension's coordinates; the map position is only where its portal leads.
      const realm = marker?.at ? marker.dimension : '', own = realm ? { x: marker.at.x, z: marker.at.z } : p;
      const stand = (built?.valid && built.stand) || (realm ? { x: own.x, y: marker.y, z: own.z } : { x: p.x, y: p.surfaceY + 1, z: p.z });
      // The card leads with where it is and the one thing worth knowing about it; the rest is under "More".
      const biome = `<i class="swatch" style="background:${terrain.colour(p.biome)}"></i>${esc(label(p.biome))}`;
      const setting = realm ? `In the ${REALMS[realm]}${shape ? ` · Y ${shape.minY} to ${shape.maxY}` : ''}` : built?.shipwreckTemplate && built.placement ? `${esc(placementName('shipwrecks', built.placement))}${built.shipY !== undefined ? ' · predicted' : ''}` : shape && stand.where === 'inside it' ? `Buried · Y ${shape.minY} to ${shape.maxY}`
        : p.water ? `Under water · ${p.surfaceY - p.groundY} deep` : `Ground Y ${p.groundY}`;
      let more = false;
      try { more = localStorage.getItem('seed-scout-inspector-more') === '1'; } catch { }
      box.innerHTML = `${head}
      <p class="place"><span><b>X</b> ${own.x}</span><span><b>Y</b> ${stand.y}</span><span><b>Z</b> ${own.z}</span></p>
      <p class="setting">${setting}<span>${realm ? 'drawn where its portal leads' : biome}</span></p>
      ${built?.valid && builtFact(built) ? `<p class="trait">${icon('check-circle')}${esc(builtFact(built))}</p>` : ''}
      ${built && !built.valid ? '<p class="notice error">The generation point is valid, but building the structure here produced no pieces.</p>' : ''}
      <div class="inspector-actions">
        <button class="btn small" id="info-tp" title="${realmCommand(realm, stand)}">${icon('terminal')}Copy /tp</button>
        <button class="btn small" id="info-copy">${icon('copy')}Copy X Z</button>
        ${marker?.source === 'pin' ? `<button class="btn small" id="info-unpin">${icon('x')}Remove pin</button>` : ''}
      </div>
      <details class="more" id="info-more"${more ? ' open' : ''}>
        <summary>More details<span class="chev">${icon('chevron')}</span></summary>
        <dl class="facts">
          ${fact('Teleport', `${stand.x} ${stand.y} ${stand.z}${stand.where ? ` <small>${esc(stand.where)}</small>` : ''}`)}
          ${stand.above ? fact('Surface above', `${stand.above.x} ${stand.above.y} ${stand.above.z} <small><button class="link" id="info-tp-above" title="The spot inside is an estimate; this one is open ground${stand.above.water ? ' (water surface)' : ''} straight above it">Copy /tp</button></small>`) : ''}
          ${realm ? fact('Portal comes out at', `X ${p.x} · Z ${p.z} <small>in the Overworld</small>`) : fact('Chunk', `${p.chunkX}, ${p.chunkZ}`)}
          ${realm ? '' : fact('Surface', `${esc(label(p.surfaceBlock || (p.water ? 'water' : 'land')))} · Y ${p.surfaceY}`)}
          ${realm ? '' : fact('Ground', `Y ${p.groundY}${p.water ? ' · below water' : ''}`)}
          ${(built?.portalSize || marker?.portalSize) ? fact('Portal size', (built?.portalSize || marker.portalSize) === 'huge' ? 'Huge (giant template)' : 'Regular') : ''}
          ${(built?.shipwreckTemplate || marker?.shipwreckTemplate) ? fact('Ship template', esc(shipTemplateName(built?.shipwreckTemplate || marker.shipwreckTemplate))) : ''}
          ${(built?.placement || marker?.placement) ? fact('Placement', esc(placementName(marker?.key || built?.key, built?.placement || marker.placement))) : ''}
          ${built?.shipDeckY !== undefined ? fact('Ship / water', `Deck Y ${built.shipDeckY} · water Y ${built.waterY} <small>Keel Y ${built.shipKeelY} · ${built.groundedHullColumns} hull columns touch ground</small>`) : ''}
          ${shape ? fact('Structure', `Y ${shape.minY} to ${shape.maxY} <small>${shape.maxX - shape.minX + 1} × ${shape.maxZ - shape.minZ + 1} blocks · ${built.pieces} piece${built.pieces === 1 ? '' : 's'}</small>`) : marker ? fact(marker.kind === 'biome' ? 'Sampled at' : marker.kind === 'terrain' ? 'Measured at' : 'Structure Y', `Y ${marker.y}`) : ''}
          ${realm ? '' : fact('Nether', `X ${Math.floor(p.x / 8)} · Z ${Math.floor(p.z / 8)}`)}
          ${realm ? '' : fact('Slime chunk', p.slimeChunk ? '<span class="yes">Yes</span>' : 'No')}
        </dl>
        ${confidence ? `<p class="confidence">${icon('check-circle')}${esc(confidence)}</p>` : ''}
        ${built?.placementAccuracy ? `<p class="hint">${esc(built.placementAccuracy)}</p>` : ''}
        <p class="hint">${realm ? 'The teleport spot is an estimate: the floor of the piece the structure grows from.' : 'Base terrain prediction. Spawn and completed-world details may differ.'}</p>
      </details>`;
      $('info-more').ontoggle = () => { try { localStorage.setItem('seed-scout-inspector-more', $('info-more').open ? '1' : '0'); } catch { } };
      $('info-close').onclick = closeInspector;
      $('info-copy').onclick = () => copyText(`${own.x} ${own.z}`, 'Coordinates copied');
      if ($('info-tp-above')) $('info-tp-above').onclick = () => copyText(`/tp @s ${stand.above.x} ${stand.above.y} ${stand.above.z}`, 'Teleport command copied · surface above it');
      $('info-tp').onclick = () => copyText(realmCommand(realm, stand), `Teleport command copied${stand.where ? ` · ${stand.where}` : ''}`);
      if ($('info-unpin')) $('info-unpin').onclick = () => { pins.set(seed, (pins.get(seed) || []).filter(f => f.id !== marker.id)); closeInspector(); };
    } catch (e) {
      if (token === clickToken) { box.innerHTML = `${head}<p class="notice error">${esc(e.message)}</p>`; $('info-close').onclick = closeInspector; }
    }
  }
  // Fly to a feature of the open seed and open it in the inspector (used by result chips).
  function focus(feature) {
    const marker = matchMarkers.find(m => m.id === markerId(feature)) || markerList.find(m => m.id === markerId(feature));
    if (!marker) return;
    flyTo(marker.x, marker.z, Math.min(bpp, 1.5)); inspect({ x: marker.x, z: marker.z }, marker);
  }
  // Keep a found feature on the map regardless of which layers are showing.
  function pin(feature) {
    if (!result) return;
    const marker = { ...feature, id: markerId(feature), source: 'pin', rank: -1 }, list = (pins.get(result.seed) || []).filter(f => f.id !== marker.id);
    pins.set(result.seed, [...list, marker]);
    flyTo(marker.x, marker.z, Math.min(bpp, 2)); inspect({ x: marker.x, z: marker.z }, marker);
  }
  function measureText() {
    if (!measure) return;
    const end = measure.b || measure.cursor, a = measure.a;
    $('measure-text').textContent = !a ? 'Click a start point on the map.'
      : `${fmt(Math.round(Math.hypot(end.x - a.x, end.z - a.z)))} blocks · ΔX ${fmt(Math.abs(end.x - a.x))} · ΔZ ${fmt(Math.abs(end.z - a.z))}${measure.b ? ' · click to start again' : ''}`;
  }
  function setMeasure(enabled) {
    if (!canvas) return;
    measure = enabled ? { a: null, b: null, cursor: null } : null;
    $('measure-bar').hidden = !enabled; $('tool-measure').classList.toggle('active', enabled); canvas.classList.toggle('measuring', enabled);
    $('map-tip').hidden = true; measureText(); invalidate();
  }
  function click(event) {
    const at = locate(event);
    if (measure) { if (!measure.a || measure.b) { measure.a = at; measure.b = null; } else measure.b = at; measure.cursor = at; measureText(); invalidate(); return; }
    const marker = markerAt(at.px, at.py);
    if (marker?.cluster) return flyTo(marker.x, marker.z, bpp / 2.5);
    inspect(marker ? { x: marker.x, z: marker.z } : at, marker, true);
  }
  function keys(event) {
    if (!result || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest?.('input,select,textarea,[contenteditable],dialog')) return;
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }, key = event.key;
    if (moves[key]) {
      // Arrow keys pan only while the map has focus, so they still scroll the side panel.
      if (event.target !== canvas && event.target !== document.body) return;
      event.preventDefault(); flyTo(centre.x + moves[key][0] * width * bpp * .35, centre.z + moves[key][1] * height * bpp * .35);
    } else if (key === '+' || key === '=') zoomBy(.5);
    else if (key === '-' || key === '_') zoomBy(2);
    else if (key === 'h' || key === 'H') home();
    else if (key === 'm' || key === 'M') setMeasure(!measure);
    else if (key === 'g' || key === 'G') { event.preventDefault(); emit('goto'); }
    else if (key === 'Escape') { if (measure) setMeasure(false); else if (selection) closeInspector(); emit('escape'); }
  }
  function init() {
    if (canvas) return;
    host = $('map');
    host.innerHTML = '<canvas id="terrain-canvas" tabindex="0" role="application" aria-label="Terrain map. Drag to pan, scroll to zoom, click to inspect."></canvas>';
    canvas = $('terrain-canvas');
    canvas.onpointerdown = e => {
      canvas.focus({ preventScroll: true }); canvas.setPointerCapture(e.pointerId); cancelAnimationFrame(anim);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), bpp }; drag = null; }
      else drag = { x: e.clientX, y: e.clientY, cx: centre.x, cz: centre.z, moved: false };
    };
    canvas.onpointermove = e => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()], distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinch.bpp * pinch.distance / distance / bpp); return;
      }
      if (drag) {
        if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) { drag.moved = true; canvas.classList.add('dragging'); }
        if (drag.moved) { centre = { x: drag.cx - (e.clientX - drag.x) * bpp, z: drag.cz - (e.clientY - drag.y) * bpp }; update(); }
      }
      describe(e);
    };
    const release = e => {
      pointers.delete(e.pointerId);
      const clicked = e.type === 'pointerup' && drag && !drag.moved && !pinch;
      if (pointers.size < 2) pinch = null;
      drag = null; canvas.classList.remove('dragging');
      if (clicked) click(e);
    };
    canvas.onpointerup = release; canvas.onpointercancel = release;
    canvas.onpointerleave = () => { if (hover) { hover = null; invalidate(); } $('map-tip').hidden = true; };
    canvas.ondblclick = e => { if (!measure) zoomAt(e.clientX, e.clientY, .5); };
    canvas.addEventListener('wheel', e => {
      e.preventDefault(); cancelAnimationFrame(anim);
      const delta = Math.max(-240, Math.min(240, e.deltaY * (e.deltaMode === 1 ? 33 : 1)));
      zoomAt(e.clientX, e.clientY, Math.exp(delta * .0022));
    }, { passive: false });
    document.addEventListener('keydown', keys);
    $('zoom-in').onclick = () => zoomBy(.5); $('zoom-out').onclick = () => zoomBy(2);
    $('tool-home').onclick = home; $('tool-fit').onclick = () => fit();
    $('tool-measure').onclick = () => setMeasure(!measure); $('measure-close').onclick = () => setMeasure(false);
    new ResizeObserver(resize).observe(host);
    window.addEventListener('resize', resize);
  }
  function setChrome(open) {
    for (const id of ['map-tools', 'scale', 'seed-chip']) $(id).hidden = !open;
    $('map-empty').hidden = open; $('map').hidden = !open;
    if (!open) { for (const id of ['inspector', 'measure-bar', 'map-tip', 'tile-progress']) $(id).hidden = true; $('status-zoom').textContent = $('status-tiles').textContent = ''; $('status-cursor').textContent = 'Local search · no world saves touched'; }
  }
  function show(value) {
    if (!value) return;
    init();
    const fresh = result?.seed !== value.seed;
    result = value;
    // A Nether match is drawn where its portal comes out in the Overworld, eight times its own coordinates, and keeps
    // those in `at`. The End has no place on this map.
    matchMarkers = value.features.filter(f => f.dimension !== 'end' && !f.area).map(f => ({ ...f, ...(f.dimension === 'nether' ? { at: { x: f.x, z: f.z }, x: f.x * 8, z: f.z * 8 } : {}), id: markerId(f), source: 'match', rank: -2 }));
    if (fresh) { selection = null; hover = null; clickToken++; statsKey = ''; $('inspector').hidden = true; if (measure) setMeasure(false); centre = { x: value.anchorX, z: value.anchorZ }; bpp = HOME_BPP; }
    setChrome(true); $('chip-seed').textContent = value.seed;
    markersDirty = true; invalidate();
    if (fresh) { pendingFit = value.features.length > 0; resize(); emit('open', value); queueLegend(); }
  }
  function clear() {
    if (!result) return;
    for (const controller of tileStreams.keys()) controller.abort();
    result = null; markerList = []; matchMarkers = []; selection = null; hover = null; clickToken++;
    if (measure) setMeasure(false);
    setChrome(false); emit('close');
  }

  // ---- Layer settings ----------------------------------------------------
  function changed() {
    featureCache = null; markersDirty = true;
    try { localStorage.setItem('seed-scout-layers', JSON.stringify(layers)); } catch { }
    invalidate();
  }
  function setLayer(name, value) { layers[name] = value; changed(); if (name === 'basemap') queueLegend(); }
  function setFeature(key, patch) { layers.features[key] = { ...defaultFeature(key), ...layers.features[key], ...patch }; changed(); }
  // Replace every layer setting at once (presets). Anything the preset leaves out returns to its default.
  function applyLayers(next) {
    const fresh = { ...structuredClone(DEFAULT_LAYERS), ...structuredClone(next || {}) };
    for (const name of Object.keys(layers)) delete layers[name];
    Object.assign(layers, fresh); changed(); queueLegend(); emit('layers');
  }
  // The complete current settings, with every structure layer spelled out, for saving as a preset.
  const snapshot = () => ({ ...structuredClone(layers), features: Object.fromEntries(features().map(f => [f.key, { on: f.on, from: f.from,
    ...Object.fromEntries(['variants', 'placements', 'templates'].filter(field => Array.isArray(f[field])).map(field => [field, [...f[field]]])) }])) });

  return {
    show, clear, on, flyTo, jump, home, fit, focus, pin, zoomBy, setMeasure,
    layers, setLayer, setFeature, applyLayers, snapshot, features, defaultFeature,
    ZOOM_STOPS, zoomLevel, refresh: changed, setDetail, detail: () => detail === 4 ? 'fast' : 'sharp',
    seed: () => result?.seed, current: () => result, view: () => ({ x: centre.x, z: centre.z, bpp }),
    biomeColour: terrain.colour, slimeChunk: isSlime,
  };
})();
