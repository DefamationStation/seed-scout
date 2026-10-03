// Terrain rasteriser: turns one 32×32 engine tile into pixels, plus vector overlays drawn on top of it.
// map.js owns tile loading and caching; this file owns how terrain looks.
const terrain = (() => {
  const SEA = 63;
  const BIOMES = {
    ocean: '#2b5a94', deep_ocean: '#1f3f73', cold_ocean: '#346f96', deep_cold_ocean: '#25507a',
    lukewarm_ocean: '#2f86a8', deep_lukewarm_ocean: '#256b90', warm_ocean: '#35a7b3',
    frozen_ocean: '#9dbfd3', deep_frozen_ocean: '#7ea3bd', river: '#3f7fb5', frozen_river: '#a9cde0',
    beach: '#e3d59c', snowy_beach: '#e6e4d2', stony_shore: '#9a9c98',
    plains: '#8cbf5e', sunflower_plains: '#a9c957', meadow: '#9ccf7e',
    forest: '#4d8c45', flower_forest: '#6aa565', birch_forest: '#73ab5f', old_growth_birch_forest: '#62994f',
    dark_forest: '#2f5233', pale_garden: '#a9aea2', dappled_forest: '#5f9455', cherry_grove: '#e7a4bf',
    taiga: '#4f7d63', old_growth_pine_taiga: '#5a7353', old_growth_spruce_taiga: '#486b55',
    snowy_taiga: '#a8c2b8', grove: '#c4d6cf', snowy_plains: '#e6eeee', ice_spikes: '#b5e0ea',
    snowy_slopes: '#d5dfe2', frozen_peaks: '#c9d6e4', jagged_peaks: '#b4b8c2', stony_peaks: '#9d9f93',
    windswept_hills: '#7d9478', windswept_forest: '#5f8565', windswept_gravelly_hills: '#8f948e',
    windswept_savanna: '#b0a660', desert: '#e8d48a', badlands: '#c9703f', eroded_badlands: '#d98a4e',
    wooded_badlands: '#a8743f', savanna: '#bdb25a', savanna_plateau: '#ada258',
    jungle: '#2f8f3a', bamboo_jungle: '#5aa637', sparse_jungle: '#6fae4a',
    swamp: '#5d7650', mangrove_swamp: '#4a6b4c', mushroom_fields: '#b46fb0',
    deep_dark: '#17303a', lush_caves: '#6f9f3f', dripstone_caves: '#8a6f55', sulfur_caves: '#c6c04e',
  };
  const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const BIOME_RGB = Object.fromEntries(Object.entries(BIOMES).map(([k, v]) => [k, hex(v)]));
  const FALLBACK = hex('#7f9460'), LAKE = hex('#3f7fb5'), SHOAL = hex('#cfc79b');
  const isWaterBiome = name => name.includes('ocean') || name.includes('river');
  const HEIGHT_RAMP = [[-64, '#234a3a'], [40, '#3f7d52'], [63, '#6fae5c'], [80, '#a8c66a'], [100, '#d9cf7c'], [130, '#c9a063'], [160, '#a67c5b'], [200, '#b5aca6'], [256, '#ffffff']].map(([v, c]) => [v, hex(c)]);
  const DEPTH_RAMP = [[0, '#5aa7d6'], [8, '#3d83bd'], [30, '#24598f'], [70, '#14365e']].map(([v, c]) => [v, hex(c)]);
  function ramp(stops, v) {
    if (v <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) if (v <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i], t = (v - a) / (b - a);
      return ca.map((n, k) => n + (cb[k] - n) * t);
    }
    return stops[stops.length - 1][1];
  }
  // Colour ramps as lookup tables, four entries per block of height or depth.
  function table(stops, from, to) {
    const out = new Uint8Array(((to - from) * 4 + 1) * 3);
    for (let i = 0; i * 3 < out.length; i++) out.set(ramp(stops, from + i / 4).map(Math.round), i * 3);
    return out;
  }
  const HEIGHT_LUT = table(HEIGHT_RAMP, -64, 256), DEPTH_LUT = table(DEPTH_RAMP, 0, 70);

  // ---- Height field ------------------------------------------------------
  // A tile is N×N samples. Shading and contours need a few samples beyond each edge, taken from the
  // neighbouring tiles so both run straight across tile borders; while a neighbour is still loading
  // the tile's own edge is repeated instead.
  const N = 32, PAD = 4, W = N + PAD * 2;
  // Native columns are samples at block centres (x + .5, z + .5), at every step.
  // A raster cell is centred on that column, rather than extending southeast from it.
  const sampleOffset = step => (1 - step) / 2;
  const placement = tile => ({ x: tile.x + sampleOffset(tile.step), z: tile.z + sampleOffset(tile.step), span: N * tile.step });
  function cell(x, z, step) {
    const col = Math.floor((x - sampleOffset(step)) / step), row = Math.floor((z - sampleOffset(step)) / step);
    const tx = Math.floor(col / N), tz = Math.floor(row / N);
    return { x: tx * N * step, z: tz * N * step, index: (row - tz * N) * N + col - tx * N };
  }
  const rasterPatterns = new WeakMap();
  function drawRaster(ctx, image, tile, left, top, size, ratio = 1) {
    ctx.imageSmoothingEnabled = tile.step > 2 && (size < image.width || (image.width > N && size > image.width * 1.25));
    const l = Math.round(left * ratio) / ratio, t = Math.round(top * ratio) / ratio;
    const r = Math.round((left + size) * ratio) / ratio, b = Math.round((top + size) * ratio) / ratio;
    if (r <= l || b <= t) return;
    let pattern = rasterPatterns.get(image);
    if (!pattern) {
      // One repeated edge pixel supports texture filtering at the tile border.
      // The fill rectangle owns whole device pixels; the texture keeps its exact world transform.
      const padded = document.createElement('canvas'), w = image.width, h = image.height;
      padded.width = w + 2; padded.height = h + 2;
      const c = padded.getContext('2d');
      c.drawImage(image, 1, 1);
      c.drawImage(image, 0, 0, w, 1, 1, 0, w, 1); c.drawImage(image, 0, h - 1, w, 1, 1, h + 1, w, 1);
      c.drawImage(image, 0, 0, 1, h, 0, 1, 1, h); c.drawImage(image, w - 1, 0, 1, h, w + 1, 1, 1, h);
      c.drawImage(image, 0, 0, 1, 1, 0, 0, 1, 1); c.drawImage(image, w - 1, 0, 1, 1, w + 1, 0, 1, 1);
      c.drawImage(image, 0, h - 1, 1, 1, 0, h + 1, 1, 1); c.drawImage(image, w - 1, h - 1, 1, 1, w + 1, h + 1, 1, 1);
      pattern = ctx.createPattern(padded, 'no-repeat');
      rasterPatterns.set(image, pattern);
    }
    const pixel = size / image.width;
    pattern.setTransform(new DOMMatrix([pixel, 0, 0, pixel, left - pixel, top - pixel]));
    ctx.fillStyle = pattern; ctx.fillRect(l, t, r - l, b - t);
  }
  const G = N + 2;                       // samples -1..N, the lattice both shading and contours are interpolated on
  const clamp = v => v < 0 ? 0 : v > N - 1 ? N - 1 : v;
  function gather(tile, around) {
    const floor = new Float32Array(W * W), wet = new Uint8Array(W * W), near = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) near.push(dx || dz ? around(dx, dz) : tile);
    for (let r = -PAD; r < N + PAD; r++) {
      const dz = r < 0 ? -1 : r >= N ? 1 : 0;
      for (let c = -PAD; c < N + PAD; c++) {
        const dx = c < 0 ? -1 : c >= N ? 1 : 0, other = near[(dz + 1) * 3 + dx + 1], from = other || tile;
        const i = other ? (r - dz * N) * N + c - dx * N : clamp(r) * N + clamp(c), o = (r + PAD) * W + c + PAD;
        floor[o] = from.elevation[i]; wet[o] = from.water[i] ? 1 : 0;
      }
    }
    return { floor, wet };
  }
  // The surface relief is read from: water is flat at sea level (or at its bed, for the rare mountain lake),
  // and dry holes below sea level (ravines, cave mouths) are filled so they do not pock the shading.
  function surface({ floor, wet }) {
    const out = new Float32Array(W * W);
    for (let i = 0; i < out.length; i++) out[i] = wet[i] ? Math.max(floor[i], SEA) : Math.max(floor[i], SEA - 1);
    return out;
  }
  // One pass of a 3×3 binomial blur. Each pass leaves one more ring of the padding unusable.
  function blur(src) {
    const mid = new Float32Array(W * W), out = new Float32Array(W * W);
    for (let r = 0; r < W; r++) for (let c = 1; c < W - 1; c++) { const i = r * W + c; mid[i] = (src[i - 1] + src[i] * 2 + src[i + 1]) / 4; }
    for (let r = 1; r < W - 1; r++) for (let c = 1; c < W - 1; c++) { const i = r * W + c; out[i] = (mid[i - W] + mid[i] * 2 + mid[i + W]) / 4; }
    return out;
  }

  // ---- Raster ------------------------------------------------------------
  // Tiles are re-rastered whenever this key changes. Contours are vector overlays, so they are not part of it.
  const styleKey = options => `${options.basemap}:${options.relief}`;

  // Hillshade. Slopes are measured in blocks per sample, and how steep real terrain is in those units depends on
  // the sampling step: coarse samples skip the gentle ground in between, and beyond a mountain's width they are
  // close to noise. So each step has its own smoothing (SOFTEN: 1 = one blur pass, 2 = two) and its own
  // yardstick (STEEP: the 90th-percentile land gradient measured on real terrain after that smoothing).
  // Dividing by the yardstick gives every zoom level the same contrast.
  const SOFTEN = { 1: 2, 2: 1, 4: .5, 8: .5, 16: .5, 32: .5, 64: 1, 128: 1.5, 256: 2 };
  // The 1- and 2-block yardsticks scale the measured 4-block gradient to keep close zooms consistent.
  const STEEP = { 1: 1.525, 2: 3.05, 4: 6.1, 8: 9.6, 16: 13.2, 32: 16.3, 64: 15.4, 128: 12.4, 256: 10.9 };
  const RELIEF = .78;                    // slope a STEEP gradient is drawn as (1 = 45°)
  const CALM = .05;                      // slopes well below this are treated as flat, so plains stay clean
  // Shaded slopes are mixed towards a cool dark, lit ones towards a warm white, so biome hues survive.
  const SHADOW = [22, 30, 52], LIGHT = [255, 248, 224], SHADOW_MIX = .62, LIGHT_MIX = .75;
  function relieved(field, step) {
    const raw = surface(field), soften = SOFTEN[step] || 1, once = blur(raw), a = Math.min(1, soften), b = soften - 1;
    for (let i = 0; i < once.length; i++) once[i] = raw[i] + (once[i] - raw[i]) * a;
    if (b <= 0) return once;
    const twice = blur(once);
    for (let i = 0; i < twice.length; i++) twice[i] = once[i] + (twice[i] - once[i]) * b;
    return twice;
  }

  // Output pixels per sample: biome cells stay crisp while shading, tint and depth are interpolated between samples.
  // Shaded or tinted land gets the most (a step-4 tile can fill 512 px on screen, the others at most 256),
  // water depth needs less, and flat-coloured land needs none.
  const detail = (step, smoothLand, anyWater) => smoothLand ? (step <= 4 ? 8 : 6) : anyWater ? 4 : 1;
  // Sub-pixel k of a sample sits between lattice points near[k] and near[k] + 1 (relative to the sample's own), frac[k] of the way.
  const SUBPIXELS = {};
  function subpixels(scale) {
    if (!SUBPIXELS[scale]) {
      const near = new Uint8Array(scale), frac = new Float32Array(scale);
      for (let k = 0; k < scale; k++) { const f = (k + .5) / scale - .5; near[k] = f < 0 ? 0 : 1; frac[k] = f < 0 ? f + 1 : f; }
      SUBPIXELS[scale] = { near, frac };
    }
    return SUBPIXELS[scale];
  }

  // tile: {x, z, step, mode, palette, biomes, elevation, water}, 1,024 samples in row-major order.
  // Every zoom and preview uses native base columns. Relief derives from elevation.
  // around(dx, dz): the adjacent tile at the same step (dx, dz in -1..1), or null while it is not loaded.
  // Limit raster pixels for small on-screen tiles while retaining every terrain sample.
  function raster(tile, options, around, maxSize = Infinity) {
    const tinted = options.basemap === 'elevation', relief = !!options.relief;
    const scale = Math.max(1, Math.min(detail(tile.step, (relief || tinted) && tile.water.some(w => !w), tile.water.some(w => w)), Math.floor(maxSize / N))), size = N * scale, { near, frac } = subpixels(scale);
    const image = document.createElement('canvas'); image.width = image.height = size;
    const c = image.getContext('2d'), pixels = c.createImageData(size, size), out = pixels.data;
    const names = tile.palette, palette = names.map(n => BIOME_RGB[n] || FALLBACK), wetBiome = names.map(isWaterBiome);
    // Dry ground inside an open-ocean biome is an islet or sandbar; river banks and ice keep their biome colour.
    const shoal = names.map(n => n.includes('ocean') && !n.includes('frozen'));

    // Lattices over samples -1..N: sea bed for water depth, ground height for the elevation tint, slope for shading.
    const field = gather(tile, around), { floor, wet } = field;
    const bed = new Float32Array(G * G), ground = new Float32Array(G * G), sx = new Float32Array(G * G), sz = new Float32Array(G * G);
    const smooth = relief ? relieved(field, tile.step) : null, gain = RELIEF / (STEEP[tile.step] || 12) / 2, calm = CALM * CALM;
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
      const o = (j + PAD - 1) * W + i + PAD - 1, g = j * G + i;
      bed[g] = floor[o]; ground[g] = wet[o] ? SEA : floor[o];
      if (relief) {
        const a = (smooth[o + 1] - smooth[o - 1]) * gain, b = (smooth[o + W] - smooth[o - W]) * gain, m = a * a + b * b, keep = m / (m + calm);
        sx[g] = a * keep; sz[g] = b * keep;
      }
    }

    for (let row = 0; row < N; row++) for (let ky = 0; ky < scale; ky++) {
      const base = (row + near[ky]) * G, ty = frac[ky];
      let p = (row * scale + ky) * size * 4;
      for (let col = 0; col < N; col++) {
        const s = row * N + col, b = tile.biomes[s], water = tile.water[s];
        const rgb = water ? (wetBiome[b] ? palette[b] : LAKE) : shoal[b] ? SHOAL : palette[b];
        for (let kx = 0; kx < scale; kx++, p += 4) {
          const g = base + col + near[kx], h = g + G, tx = frac[kx];
          let r, gr, bl;
          if (water) {
            const top = bed[g] + (bed[g + 1] - bed[g]) * tx, low = bed[h] + (bed[h + 1] - bed[h]) * tx, depth = SEA - (top + (low - top) * ty);
            if (tinted) { const q = (depth <= 0 ? 0 : depth >= 70 ? 280 : depth * 4 + .5 | 0) * 3; r = DEPTH_LUT[q]; gr = DEPTH_LUT[q + 1]; bl = DEPTH_LUT[q + 2]; }
            else { const k = depth <= 0 ? 1 : depth >= 63.4 ? .62 : 1 - depth * .006; r = rgb[0] * k; gr = rgb[1] * k; bl = rgb[2] * k; }
          } else {
            if (tinted) {
              const top = ground[g] + (ground[g + 1] - ground[g]) * tx, low = ground[h] + (ground[h + 1] - ground[h]) * tx, y = top + (low - top) * ty;
              const q = (y <= -64 ? 0 : y >= 256 ? 1280 : (y + 64) * 4 + .5 | 0) * 3; r = HEIGHT_LUT[q]; gr = HEIGHT_LUT[q + 1]; bl = HEIGHT_LUT[q + 2];
            } else { r = rgb[0]; gr = rgb[1]; bl = rgb[2]; }
            if (relief) {
              // Lambert shading for a light in the north-west, 45° up, relative to flat ground (0 = flat).
              const at = sx[g] + (sx[g + 1] - sx[g]) * tx, al = sx[h] + (sx[h + 1] - sx[h]) * tx, a = at + (al - at) * ty;
              const dt = sz[g] + (sz[g + 1] - sz[g]) * tx, dl = sz[h] + (sz[h + 1] - sz[h]) * tx, d = dt + (dl - dt) * ty;
              const lit = (1 + (a + d) * .7071) / Math.sqrt(1 + a * a + d * d) - 1;
              if (lit < 0) { const t = (lit < -1 ? 1 : -lit) * SHADOW_MIX; r += (SHADOW[0] - r) * t; gr += (SHADOW[1] - gr) * t; bl += (SHADOW[2] - bl) * t; }
              else { const t = lit * LIGHT_MIX; r += (LIGHT[0] - r) * t; gr += (LIGHT[1] - gr) * t; bl += (LIGHT[2] - bl) * t; }
            }
          }
          out[p] = r; out[p + 1] = gr; out[p + 2] = bl; out[p + 3] = 255;
        }
      }
    }
    c.putImageData(pixels, 0, 0);
    return image;
  }

  // ---- Contours ----------------------------------------------------------
  // Contour interval and index (heavier, labelled) interval in blocks, by sampling step.
  const INTERVALS = { 4: [10, 50], 8: [20, 100], 16: [20, 100], 32: [25, 100], 64: [25, 100], 128: [50, 200], 256: [50, 200] };
  const CELLS = G - 1, HN = CELLS * G, EDGES = HN * 2;
  const link0 = new Int16Array(EDGES), link1 = new Int16Array(EDGES), seen = new Uint8Array(EDGES);
  const px = new Float64Array(EDGES + 2), pz = new Float64Array(EDGES + 2);
  const contourCache = new WeakMap();
  // One dark sepia for every base map: it stays readable on snow and desert and still shows on dark forest.
  const MINOR = 'rgba(48,30,14,.4)', INDEX = 'rgba(48,30,14,.64)', INK = 'rgba(48,30,14,.95)', HALO = 'rgba(255,255,255,.7)';
  const LABEL_FROM = 150;                // tiles drawn smaller than this many CSS px leave their index contours unlabelled

  function contours(tile, around) {
    const field = gather(tile, around), { floor, wet } = field, smooth = blur(blur(surface(field)));
    const value = new Float32Array(G * G), sea = new Uint8Array(G * G);
    let low = Infinity, high = -Infinity;
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
      const o = (j + PAD - 1) * W + i + PAD - 1, g = j * G + i;
      sea[g] = wet[o];
      const v = value[g] = wet[o] ? Math.max(floor[o], SEA) : smooth[o];
      if (v < low) low = v; if (v > high) high = v;
    }
    const [interval, major] = INTERVALS[tile.step] || (tile.step < 8 ? [10, 50] : tile.step < 64 ? [20, 100] : [50, 200]);
    const built = { minor: null, index: null, labels: [] };
    const first = Math.max(Math.ceil((SEA + 4) / interval), Math.ceil(low / interval)) * interval;
    const candidates = [];

    // Where the contour at `level` crosses a lattice edge, in tile units (0..N across the tile).
    // Against water the crossing is pulled into the land half of the edge, so lines never run over water.
    function cross(edge, level, k) {
      let a, b, wa, wb, x, z, across;
      if (edge < HN) { const j = edge / CELLS | 0, i = edge - j * CELLS, g = j * G + i; a = value[g]; b = value[g + 1]; wa = sea[g]; wb = sea[g + 1]; x = i - .5; z = j - .5; across = true; }
      else { const e = edge - HN, j = e / G | 0, i = e - j * G, g = j * G + i; a = value[g]; b = value[g + G]; wa = sea[g]; wb = sea[g + G]; x = i - .5; z = j - .5; across = false; }
      let t = (level - a) / (b - a);
      if (wa && !wb) t = .5 + t / 2; else if (wb && !wa) t /= 2;
      if (across) x += t; else z += t;
      px[k] = x; pz[k] = z;
    }
    const join = (a, b) => {
      if (link0[a] < 0) link0[a] = b; else link1[a] = b;
      if (link0[b] < 0) link0[b] = a; else link1[b] = a;
    };

    for (let level = first; level <= high; level += interval) {
      link0.fill(-1); link1.fill(-1); seen.fill(0);
      let any = false;
      for (let j = 0; j < CELLS; j++) for (let i = 0; i < CELLS; i++) {
        const g = j * G + i, a = value[g] >= level, b = value[g + 1] >= level, c = value[g + G + 1] >= level, d = value[g + G] >= level;
        const kind = (a << 3) | (b << 2) | (c << 1) | d;
        if (kind === 0 || kind === 15) continue;
        any = true;
        const top = j * CELLS + i, bottom = top + CELLS, left = HN + j * G + i, right = left + 1;
        switch (kind) {
          case 1: case 14: join(left, bottom); break;
          case 2: case 13: join(bottom, right); break;
          case 3: case 12: join(left, right); break;
          case 4: case 11: join(top, right); break;
          case 6: case 9: join(top, bottom); break;
          case 7: case 8: join(top, left); break;
          default: {
            // Saddle: the cell centre decides which pair of corners is connected.
            const inside = (value[g] + value[g + 1] + value[g + G] + value[g + G + 1]) / 4 >= level;
            if ((kind === 5) === inside) { join(top, left); join(bottom, right); } else { join(top, right); join(left, bottom); }
          }
        }
      }
      if (!any) continue;
      const heavy = level % major === 0, path = built[heavy ? 'index' : 'minor'] ||= new Path2D();
      // Open lines first (they start on the lattice rim), then closed rings.
      for (let pass = 0; pass < 2; pass++) for (let start = 0; start < EDGES; start++) {
        if (seen[start] || link0[start] < 0 || (pass === 0 && link1[start] >= 0)) continue;
        let n = 0, prev = -1, edge = start;
        while (edge >= 0 && !seen[edge]) {
          seen[edge] = 1; cross(edge, level, n++);
          const next = link0[edge] === prev ? link1[edge] : link0[edge];
          prev = edge; edge = next;
        }
        trace(path, n, pass === 1, heavy ? level : 0, candidates);
      }
    }
    built.labels = place(candidates);
    return built;
  }

  // Adds one traced line (px/pz[0..n)) to the path, clipped to the tile and rounded into a smooth curve:
  // a quadratic B-spline through the midpoints of the traced segments. Lines are cut exactly on the tile
  // border, where the neighbouring tile's copy of the same line carries on in the same direction.
  const run = [];
  function trace(path, n, closed, label, candidates) {
    const inside = k => px[k] >= 0 && px[k] <= N && pz[k] >= 0 && pz[k] <= N;
    if (closed) {
      let out = -1;
      for (let k = 0; k < n; k++) if (!inside(k)) { out = k; break; }
      if (out < 0) {
        // A ring wholly inside the tile.
        if (n < 3) return;
        path.moveTo((px[n - 1] + px[0]) / 2, (pz[n - 1] + pz[0]) / 2);
        for (let k = 0; k < n; k++) { const m = (k + 1) % n; path.quadraticCurveTo(px[k], pz[k], (px[k] + px[m]) / 2, (pz[k] + pz[m]) / 2); }
        path.closePath();
        if (label) { run.length = 0; for (let k = 0; k <= n; k++) run.push(px[k % n], pz[k % n]); candidate(label, candidates); run.length = 0; }
        return;
      }
      // Start the ring from a point outside the tile so no visible piece spans the seam.
      if (out > 0) {
        const x = Array.from(px.subarray(0, n)), z = Array.from(pz.subarray(0, n));
        for (let k = 0; k < n; k++) { px[k] = x[(k + out) % n]; pz[k] = z[(k + out) % n]; }
      }
      px[n] = px[0]; pz[n] = pz[0]; n++;
    }
    run.length = 0;
    for (let k = 0; k + 1 < n; k++) {
      // Liang–Barsky clip of the segment k → k+1 against the tile square.
      const x0 = px[k], z0 = pz[k], dx = px[k + 1] - x0, dz = pz[k + 1] - z0;
      let t0 = 0, t1 = 1, ok = true;
      for (let side = 0; side < 4 && ok; side++) {
        const p = side === 0 ? -dx : side === 1 ? dx : side === 2 ? -dz : dz, q = side === 0 ? x0 : side === 1 ? N - x0 : side === 2 ? z0 : N - z0;
        if (p === 0) { if (q < 0) ok = false; }
        else { const t = q / p; if (p < 0) { if (t > t1) ok = false; else if (t > t0) t0 = t; } else if (t < t0) ok = false; else if (t < t1) t1 = t; }
      }
      if (!ok) { flush(path, label, candidates); continue; }
      if (t0 > 0 || !run.length) { flush(path, label, candidates); run.push(x0 + dx * t0, z0 + dz * t0); }
      run.push(x0 + dx * t1, z0 + dz * t1);
      if (t1 < 1) flush(path, label, candidates);
    }
    flush(path, label, candidates);
  }
  function flush(path, label, candidates) {
    const n = run.length / 2;
    if (n >= 2) {
      path.moveTo(run[0], run[1]);
      if (n > 2) path.lineTo((run[0] + run[2]) / 2, (run[1] + run[3]) / 2);
      for (let k = 1; k < n - 1; k++) path.quadraticCurveTo(run[k * 2], run[k * 2 + 1], (run[k * 2] + run[k * 2 + 2]) / 2, (run[k * 2 + 1] + run[k * 2 + 3]) / 2);
      path.lineTo(run[n * 2 - 2], run[n * 2 - 1]);
      if (label) candidate(label, candidates);
    }
    run.length = 0;
  }

  // ---- Contour labels ----------------------------------------------------
  // A label sits on a straight-ish stretch of an index contour, away from the tile's edges
  // (a neighbouring tile's image would paint over anything that spills across).
  const EDGE = 4.5, REACH = 2.5;
  function candidate(level, candidates) {
    const n = run.length / 2;
    let total = 0;
    for (let k = 1; k < n; k++) total += Math.hypot(run[k * 2] - run[k * 2 - 2], run[k * 2 + 1] - run[k * 2 - 1]);
    if (total < REACH * 3) return;
    // Walk to the middle of the line, then measure how straight it is REACH either side.
    const at = along => {
      let rest = along;
      for (let k = 1; k < n; k++) {
        const d = Math.hypot(run[k * 2] - run[k * 2 - 2], run[k * 2 + 1] - run[k * 2 - 1]);
        if (rest <= d || k === n - 1) { const t = d ? Math.min(1, rest / d) : 0; return [run[k * 2 - 2] + (run[k * 2] - run[k * 2 - 2]) * t, run[k * 2 - 1] + (run[k * 2 + 1] - run[k * 2 - 1]) * t]; }
        rest -= d;
      }
      return [run[0], run[1]];
    };
    let best = null;
    for (const share of [.5, .35, .65, .2, .8]) {
      const mid = total * share;
      if (mid < REACH || mid > total - REACH) continue;
      const [x, z] = at(mid), [ax, az] = at(mid - REACH), [bx, bz] = at(mid + REACH);
      if (x < EDGE || z < EDGE || x > N - EDGE || z > N - EDGE) continue;
      const straight = Math.hypot(bx - ax, bz - az) / (REACH * 2);
      if (straight < .9) continue;
      if (!best || straight > best.straight) best = { x, z, angle: Math.atan2(bz - az, bx - ax), straight, level, total };
      if (straight > .97) break;
    }
    if (best) candidates.push(best);
  }
  function place(candidates) {
    const chosen = [];
    candidates.sort((a, b) => b.total - a.total);
    for (const c of candidates) {
      if (chosen.length >= 2) break;
      if (chosen.some(o => o.text === String(c.level) || Math.hypot(o.x - c.x, o.z - c.z) < 10)) continue;
      let angle = c.angle;
      if (angle > Math.PI / 2) angle -= Math.PI; else if (angle < -Math.PI / 2) angle += Math.PI;
      chosen.push({ x: c.x, z: c.z, angle, text: String(c.level) });
    }
    return chosen;
  }

  // Vector overlays for one tile, drawn straight after its image. Coordinates are CSS pixels:
  // (left, top) is the tile's top-left corner on screen and `size` its width and height.
  function overlay(ctx, tile, options, around, left, top, size) {
    // Quick overview tiles carry estimated heights in 8-block steps: enough for shading, too coarse for contour lines.
    if (!options.contours || tile.mode === 'quick') return;
    // Lines are traced once per tile and kept; they are traced again when a neighbour has arrived (or gone) since.
    const beside = k => around(k % 3 - 1, (k / 3 | 0) - 1);
    let cached = contourCache.get(tile), fresh = !!cached;
    for (let k = 0; fresh && k < 9; k++) if (k !== 4 && beside(k) !== cached.near[k]) fresh = false;
    if (!fresh) {
      cached = contours(tile, around);
      cached.near = Array.from({ length: 9 }, (_, k) => k === 4 ? null : beside(k));
      contourCache.set(tile, cached);
    }
    if (!cached.minor && !cached.index) return;
    const scale = size / N;
    ctx.save();
    ctx.translate(left, top); ctx.scale(scale, scale);
    ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
    if (cached.minor) { ctx.strokeStyle = MINOR; ctx.lineWidth = .8 / scale; ctx.stroke(cached.minor); }
    if (cached.index) { ctx.strokeStyle = INDEX; ctx.lineWidth = 1.3 / scale; ctx.stroke(cached.index); }
    ctx.restore();
    if (cached.labels.length && size >= LABEL_FROM) {
      ctx.save();
      ctx.font = '600 10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = HALO; ctx.fillStyle = INK;
      for (const l of cached.labels) {
        ctx.save();
        ctx.translate(left + l.x * scale, top + l.z * scale); ctx.rotate(l.angle);
        ctx.strokeText(l.text, 0, 0); ctx.fillText(l.text, 0, 0);
        ctx.restore();
      }
      ctx.restore();
    }
  }

  return { BIOMES, colour: key => BIOMES[key] || '#7f9460', styleKey, raster, overlay, sampleOffset, placement, cell, drawRaster };
})();
