// Seed Scout shell: side panels, seed search conditions, results and layer controls.
// The map itself lives in map.js (worldMap) and terrain drawing in terrain.js.
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n).toLocaleString('en-US');

// 24×24 stroke icons. The same path data is drawn into HTML and onto the map canvas.
const CIRCLE = 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0';
const ICONS = {
  search: 'M4 10.5a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0-13 0M15.3 15.3 20 20',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  layers: 'M12 3 3 8l9 5 9-5zM3 12.5l9 5 9-5M3 17l9 5 9-5',
  map: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14',
  info: `${CIRCLE}M12 11v5M12 8h.01`,
  power: 'M12 3v8M6.3 6.8a8 8 0 1 0 11.4 0',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  x: 'M6 6l12 12M18 6 6 18',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  'check-circle': `${CIRCLE}M8.5 12.5l2.5 2.5 4.5-5`,
  chevron: 'M6 9l6 6 6-6',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  upload: 'M12 16V5M7 9l5-5 5 5M5 20h14',
  gem: 'M6 4h12l4 6-10 11L2 10zM2 10h20M9 4l-2 6 5 11 5-11-2-6',
  play: 'M8 5l11 7-11 7z',
  stop: 'M6.5 6.5h11v11h-11z',
  crosshair: 'M5 12a7 7 0 1 0 14 0a7 7 0 1 0-14 0M12 2v5M12 17v5M2 12h5M17 12h5',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M13 7a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  ruler: 'M3 17 17 3l4 4L7 21zM7.5 12.5l2 2M10.5 9.5l2 2M13.5 6.5l2 2',
  frame: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  north: 'M12 3l5.5 17-5.5-4-5.5 4z',
  home: 'M3 10l9-7 9 7M5 9v12h14V9M9 21v-8h6v8',
  spawn: 'M12 2.8l2.8 5.9 6.4.9-4.6 4.5 1.1 6.4L12 17.5l-5.7 3 1.1-6.4-4.6-4.5 6.4-.9z',
  grid: 'M4 4h16v16H4zM4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16',
  mountain: 'M2.5 19 9 7l4 7 2.5-4 6 9z',
  contour: 'M12 4c4.5 0 8 3 8 7.5S16.5 20 12 20s-8-3.5-8-8 3.5-8 8-8zM12 8.5c2 0 3.5 1.3 3.5 3.3S14 15.5 12 15.5 8.5 14 8.5 12s1.5-3.5 3.5-3.5z',
  slime: 'M5 5h14v14H5zM9 10h.01M15 10h.01M9.5 15h5',
  tag: 'M4 4h8l8 8-8 8-8-8zM8.5 8.5h.01',
  pin: 'M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11zM9.8 10a2.2 2.2 0 1 0 4.4 0a2.2 2.2 0 1 0-4.4 0',
  terminal: 'M5 8l4 4-4 4M12 16h7',
  bookmark: 'M6 4h12v17l-6-4.5L6 21z',
  trash: 'M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v6M14 11v6',
  tree: 'M12 22v-7M12 15c-4 0-7-2.7-7-6.5C5 5.2 8 3 12 3s7 2.2 7 5.5c0 3.8-3 6.5-7 6.5z',
  // Structures
  village: 'M3 11.5 12 4l9 7.5M5.5 10v10h13V10M10 20v-5.5h4V20',
  outpost: 'M6 21V4M6 5h11l-3 4 3 4H6',
  mansion: 'M3 21V10l4.5-4 4.5 4 4.5-4 4.5 4v11zM10 21v-5h4v5M6.5 13.5h2M15.5 13.5h2',
  hut: 'M4 12l8-7 8 7M6 11v6h12v-6M8 17v4M16 17v4',
  igloo: 'M3 19a9 9 0 0 1 18 0zM9 19v-4a3 3 0 0 1 6 0v4',
  camp: 'M2 20h20M4.5 20 12 5l7.5 15M12 12l-3.5 8M12 12l3.5 8',
  pyramid: 'M2 20 12 4l10 16zM12 4l3.5 16',
  temple: 'M2 20h20M4 20v-5h4v-5h8v5h4v5M10 10V6h4v4',
  portal: 'M6 3h12v18H6zM10 7h4v10h-4z',
  urn: 'M9 4h6M10 4v3c-3 1-5 3.8-5 7a7 7 0 0 0 14 0c0-3.2-2-6-5-7V4',
  city: 'M3 9l9-5 9 5M4 9h16M6 9v9M10 9v9M14 9v9M18 9v9M3 20h18',
  pickaxe: 'M4 20 15 9M9 4c5.5 0 11 5.5 11 11',
  castle: 'M4 21V8h3V5h3v3h4V5h3v3h3v13zM10 21v-5a2 2 0 0 1 4 0v5',
  key: 'M4 15.5a4 4 0 1 0 8 0a4 4 0 1 0-8 0M11 12.5 20 3.5M16.5 7l3 3M13.5 10l2 2',
  eye: 'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12zM9.3 12a2.7 2.7 0 1 0 5.4 0a2.7 2.7 0 1 0-5.4 0',
  column: 'M8 14V6h3v3h2V5h3v9M2 18c2-2 4-2 6 0s4 2 6 0 4-2 6 0',
  ship: 'M3 15h18l-3 5H6zM12 15V4M12 5l6 7h-6',
  chest: 'M4 10a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v9H4zM4 12.5h16M12 11v3.5',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name] || ICONS.pin}"/></svg>`;

// Marker symbology: icon per structure type, colour per group.
const GROUPS = {
  settlement: { name: 'Settlements', colour: '#f4b860' },
  ruin: { name: 'Ruins & temples', colour: '#ef8f6b' },
  underground: { name: 'Underground', colour: '#b9a0f4' },
  ocean: { name: 'Ocean', colour: '#62c8ea' },
  biome: { name: 'Biome match', colour: '#8fdc9a' },
  other: { name: 'Other structures', colour: '#d6dde0' },
};
const STRUCTURES = {
  villages: ['Village', 'village', 'settlement'], pillager_outposts: ['Pillager outpost', 'outpost', 'settlement'],
  woodland_mansions: ['Woodland mansion', 'mansion', 'settlement'], swamp_huts: ['Swamp hut', 'hut', 'settlement'],
  igloos: ['Igloo', 'igloo', 'settlement'], abandoned_camp: ['Abandoned camp', 'camp', 'settlement'],
  desert_pyramids: ['Desert pyramid', 'pyramid', 'ruin'], jungle_temples: ['Jungle temple', 'temple', 'ruin'],
  ruined_portals: ['Ruined portal', 'portal', 'ruin'],
  huge_ruined_portals: ['Huge ruined portal', 'portal', 'ruin'],
  ruined_portals_on_land_surface: ['Ruined portal (on land surface)', 'portal', 'ruin'],
  ruined_portals_partly_buried: ['Ruined portal (partly buried)', 'portal', 'ruin'],
  ruined_portals_on_ocean_floor: ['Ruined portal (on ocean floor)', 'portal', 'ocean'],
  ruined_portals_in_mountain: ['Ruined portal (in mountain)', 'portal', 'underground'],
  ruined_portals_underground: ['Ruined portal (underground)', 'portal', 'underground'],
  trail_ruins: ['Trail ruins', 'urn', 'ruin'],
  ancient_cities: ['Ancient city', 'city', 'underground'], mineshafts: ['Mineshaft', 'pickaxe', 'underground'],
  strongholds: ['Stronghold', 'castle', 'underground'], trial_chambers: ['Trial chamber', 'key', 'underground'],
  ocean_monuments: ['Ocean monument', 'eye', 'ocean'], ocean_ruins: ['Ocean ruins', 'column', 'ocean'],
  shipwrecks: ['Shipwreck', 'ship', 'ocean'], buried_treasures: ['Buried treasure', 'chest', 'ocean'],
};
const label = key => STRUCTURES[key]?.[0] || String(key).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
const STRUCTURE_FAMILIES = ['villages', 'mineshafts', 'ocean_ruins', 'shipwrecks', 'abandoned_camp', 'igloos', 'ruined_portals', 'huge_ruined_portals'];
const PORTAL_FAMILIES = ['ruined_portals', 'huge_ruined_portals'];
const isPortalFamily = family => PORTAL_FAMILIES.includes(family);
const PORTAL_PLACEMENTS = ['on_land_surface', 'partly_buried', 'on_ocean_floor', 'in_mountain', 'underground'];
const SUBCATEGORY_FILTERS = ['variants', 'placements', 'templates'];
const SHIP_PLACEMENTS = { afloat: 'Floating at water surface', surface: 'Surface / shallow-water wreck', submerged: 'Deck underwater', beached: 'Beached / on land' };
const placementName = (family, value) => family === 'shipwrecks' ? SHIP_PLACEMENTS[value] || label(value) : label(value);
function shipTemplateName(template) {
  const name = template.split('/').pop(), degraded = name.endsWith('_degraded');
  const shape = name.startsWith('with_mast') ? 'Whole ship with mast' : name.includes('_fronthalf') ? 'Front half' : name.includes('_backhalf') ? 'Back half' : 'Whole ship';
  const orientation = name.startsWith('upsidedown') ? 'Upside down' : name.startsWith('sideways') ? 'Sideways' : 'Upright';
  return `${shape} · ${orientation} · ${degraded ? 'Degraded' : 'Non-degraded'}`;
}
// Shipwreck templates are template files. For the other families the engine reads a trait from the built structure.
const TRAITS = { inhabited: 'Inhabited', abandoned: 'Abandoned (zombie)', single: 'Single ruin', cluster: 'Cluster of ruins', basement: 'With basement', no_basement: 'No basement' };
const templateName = (family, template) => family === 'shipwrecks' ? shipTemplateName(template) : TRAITS[template] || label(template);
const templateTitle = family => ({ shipwrecks: 'Ship templates', villages: 'Inhabitants', ocean_ruins: 'Sizes', igloos: 'Basement options' })[family] || 'Templates';
const familyName = key => ({ igloos: 'Igloos', villages: 'Villages', mineshafts: 'Mineshafts', ocean_ruins: 'Ocean ruins', shipwrecks: 'Shipwrecks', abandoned_camp: 'Abandoned camps', ruined_portals: 'Ruined portals (any size)', huge_ruined_portals: 'Huge ruined portals' })[key] || label(key);
function variantName(family, detail) {
  if (family === 'mineshafts') return detail === 'mineshaft' ? 'Normal' : 'Badlands';
  if (family === 'shipwrecks') return detail === 'shipwreck' ? 'Regular' : 'Beached';
  if (isPortalFamily(family) && detail === 'ruined_portal') return 'Standard';
  const prefix = isPortalFamily(family) ? 'ruined_portal_' : { villages: 'village_', ocean_ruins: 'ocean_ruin_', abandoned_camp: 'abandoned_camp_' }[family];
  return (prefix ? detail.replace(prefix, '') : detail).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}
const familyVariants = family => catalog?.structureVariants?.[family] || [];
const familyTemplates = family => catalog?.structureTemplates?.[family] || [];
const familyKeys = family => [family, ...familyVariants(family), ...(isPortalFamily(family) ? PORTAL_PLACEMENTS.map(p => `${family}_${p}`).filter(k => catalog?.sets.includes(k)) : [])];
const rootStructure = key => !key.includes('__') && !PORTAL_FAMILIES.some(family => key.startsWith(`${family}_`));
function featureStyle(kind, key) {
  if (kind === 'biome') return { icon: 'tree', colour: GROUPS.biome.colour, group: 'biome' };
  const [, glyph = 'pin', group = 'other'] = STRUCTURES[key] || [];
  return { icon: glyph, colour: GROUPS[group].colour, group };
}
const glyph = (kind, key) => kind === 'biome'
  ? `<span class="glyph solid" style="--c:${worldMap.biomeColour(key)}"></span>`
  : `<span class="glyph" style="--c:${featureStyle(kind, key).colour}">${icon(featureStyle(kind, key).icon)}</span>`;

const chosen = new Map();
let catalog = null, kind = 'structure', state = {}, selectedSeed = null, manualResults = [], resultsSignature = null, toastTimer = 0;
const fields = ['anchor', 'radius', 'x', 'z', 'threads', 'seed', 'limit', 'maxMatches', 'cluster', 'biomeMode'];

// PC usage presets: the share of the logical cores given to searches and to map tiles.
const WORKER_STEPS = [1, 2, 4, 6, 8, 12, 16, 20, 24, 28, 32, 48, 64];
// Map tiles gain about 15% from 16 to 24 workers on a 32-thread PC and nothing beyond that.
const USAGE = { quiet: [1 / 8, 1 / 8], balanced: [1 / 4, 1 / 4], maximum: [7 / 8, 3 / 4] };
const nearestStep = (target, cores) => WORKER_STEPS.filter(n => n <= Math.max(1, Math.min(cores, target))).pop() || 1;
const usagePlan = name => { const cores = catalog?.cores || 8, [search, map] = USAGE[name]; return { threads: nearestStep(cores * search, cores), mapWorkers: Math.max(Math.min(2, cores), nearestStep(cores * map, cores)) }; };
// The preset whose numbers match the two selects, or "custom".
function showUsage() {
  const now = `${$('threads').value}/${$('mapWorkers').value}`;
  $('usage').value = Object.keys(USAGE).find(name => { const plan = usagePlan(name); return `${plan.threads}/${plan.mapWorkers}` === now; }) || 'custom';
}
async function setMapWorkers(count) {
  try { const saved = await api('/api/config', { mapWorkers: +count }); if (catalog) catalog.mapWorkers = saved.mapWorkers; }
  catch (e) { toast(e.message, true); }
}
// ---- Minecraft version ----------------------------------------------------
// The engine runs the installed game's own world generation, so the version is whichever installed one is picked here.
const versionName = id => `Java ${id.replace('-snapshot-', ' Snapshot ').replace('-pre-', ' Pre-release ').replace('-rc-', ' Release candidate ')}`;
async function loadVersions() {
  const select = $('version');
  try {
    const { current, versions } = await (await fetch('/api/versions')).json();
    select.innerHTML = versions.map(v => `<option value="${esc(v.id)}">${esc(versionName(v.id))}</option>`).join('');
    select.value = select.dataset.current = current;
    select.disabled = versions.length < 2;
  } catch { select.innerHTML = `<option>${esc(versionName(catalog?.version || ''))}</option>`; }
}
$('version').onchange = async () => {
  const select = $('version'), wanted = select.value;
  select.disabled = true; toast(`Switching to ${versionName(wanted)}…`);
  // The map, results and caches all belong to the old version, so the page starts over on the new one.
  try { await api('/api/version', { version: wanted }); location.reload(); }
  catch (e) { select.value = select.dataset.current; select.disabled = false; toast(e.message, true); }
};
// ---- First run and returning --------------------------------------------
$('empty-search').onclick = () => { document.querySelector('[data-preset="starter"]').click(); startSearch(); };
$('empty-random').onclick = () => openSeed(String(BigInt.asIntN(64, crypto.getRandomValues(new BigUint64Array(1))[0])));
// The seed and view that were on screen last time come back when the app opens.
let lastViewTimer = 0;
worldMap.on('view', view => {
  clearTimeout(lastViewTimer);
  lastViewTimer = setTimeout(() => { try { if (worldMap.seed()) localStorage.setItem('seed-scout-last-view', JSON.stringify({ seed: worldMap.seed(), x: Math.round(view.x), z: Math.round(view.z), bpp: view.bpp })); } catch { } }, 600);
});
worldMap.on('close', () => { try { localStorage.removeItem('seed-scout-last-view'); } catch { } });
async function restoreLastView() {
  let last = null;
  try { last = JSON.parse(localStorage.getItem('seed-scout-last-view')); } catch { }
  if (!last || !/^-?\d+$/.test(last.seed || '')) return;
  try {
    const result = allResults().find(r => r.seed === last.seed) || await api('/api/open', { seed: last.seed, x: 0, z: 0 });
    if (!allResults().some(r => r.seed === result.seed)) manualResults.unshift(result);
    selectSeed(result); worldMap.jump(last.x, last.z, last.bpp);
  } catch { }
}
// ---- Saved condition presets ---------------------------------------------
// Beside the three built-in ones: the chosen features with their distances, and the search origin settings.
const PRESET_FIELDS = ['anchor', 'radius', 'x', 'z', 'cluster', 'biomeMode'];
function conditionPresets() { try { return JSON.parse(localStorage.getItem('seed-scout-condition-presets')) || []; } catch { return []; } }
function renderConditionPresets() {
  $('saved-presets').innerHTML = conditionPresets().map((p, i) => `<span class="saved-preset"><button data-saved-preset="${i}" title="Use these conditions">${esc(p.name)}</button><button data-delete-preset="${i}" title="Delete this preset" aria-label="Delete preset ${esc(p.name)}">×</button></span>`).join('');
}
$('saved-presets').onclick = e => {
  const use = e.target.closest('[data-saved-preset]'), remove = e.target.closest('[data-delete-preset]'), all = conditionPresets();
  if (remove) { all.splice(Number(remove.dataset.deletePreset), 1); localStorage.setItem('seed-scout-condition-presets', JSON.stringify(all)); return renderConditionPresets(); }
  if (!use || !catalog) return;
  const preset = all[Number(use.dataset.savedPreset)];
  chosen.clear();
  for (const f of preset.chosen) if ((f.kind === 'structure' ? catalog.sets : catalog.biomes).includes(f.key)) chosen.set(`${f.kind}:${f.key}`, condition(f.kind, f.key, f));
  for (const [k, v] of Object.entries(preset.fields || {})) if (PRESET_FIELDS.includes(k) && $(k)) $(k).value = v;
  Object.assign(spawnRules, { biomeMode: 'any', biomes: [], slimeCount: 0, slimeRadius: 5 }, preset.spawn || {}); renderSpawnRules();
  syncAnchor(); renderFeatures(); renderChosen(); save();
};
$('condition-preset-save').onclick = () => { commitConditionFields(); $('condition-preset-form').hidden = false; $('condition-preset-name').value = ''; $('condition-preset-name').focus(); };
$('condition-preset-cancel').onclick = () => { $('condition-preset-form').hidden = true; };
$('condition-preset-form').onsubmit = e => {
  e.preventDefault();
  const name = $('condition-preset-name').value.trim();
  if (!name) return;
  if (!chosen.size && !spawnRulesActive()) return toast('Choose at least one feature or spawn condition first.', true);
  const all = conditionPresets().filter(p => p.name !== name);
  if (all.length >= 20) return toast('You can keep up to 20 presets. Delete one first.', true);
  all.push({ name, chosen: [...chosen.values()], fields: Object.fromEntries(PRESET_FIELDS.map(k => [k, $(k).value])), spawn: { ...spawnRules, biomes: [...spawnRules.biomes] } });
  localStorage.setItem('seed-scout-condition-presets', JSON.stringify(all));
  $('condition-preset-form').hidden = true; renderConditionPresets(); toast(`Preset "${name}" saved`);
};

// ---- Odds and time before starting ---------------------------------------
// Shown when exactly these conditions were searched before (the last search, or a rare find in the catalogue).
let estimateTimer = 0, estimateToken = 0;
const duration = seconds => seconds < 1.5 ? 'a second' : seconds < 90 ? `${Math.round(seconds)} seconds` : seconds < 5400 ? `${Math.round(seconds / 60)} minutes` : `${(seconds / 3600).toFixed(1)} hours`;
function queueEstimate() {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(async () => {
    const token = ++estimateToken, line = $('estimate');
    let found = null;
    try { if (catalog && (chosen.size || spawnRulesActive())) found = await api('/api/estimate', request()); } catch { }
    if (token !== estimateToken) return;
    line.hidden = !found?.known;
    if (!found?.known) return;
    const wanted = Number($('maxMatches').value) || 10, budget = Number($('limit').value) || 0, needed = found.seedsPerMatch * wanted;
    line.textContent = `About 1 in ${fmt(found.seedsPerMatch)} seeds matched ${found.source === 'catalogue' ? 'in your catalogue' : 'in the last search'}${found.matches < 5 ? ' (a rough figure)' : ''}`
      + (found.rate ? ` · roughly ${duration(needed / found.rate)} for ${fmt(wanted)} result${wanted === 1 ? '' : 's'} at ${fmt(Math.round(found.rate))} seeds a second` : '')
      + (budget && needed > budget ? ` · the ${fmt(budget)}-seed budget would find about ${fmt(Math.floor(budget / found.seedsPerMatch))}` : '') + '.';
  }, 500);
}
// ---- Settings pane -------------------------------------------------------
// The desktop shell handles seedscout:// links itself (folder picker, updates, import); a browser has no shell.
document.documentElement.classList.toggle('desktop', navigator.userAgent.includes('Electron'));
document.querySelectorAll('[data-shell]').forEach(button => { button.onclick = () => window.open(`seedscout://${button.dataset.shell}`); });
$('map-detail').value = worldMap.detail();
$('map-detail').onchange = () => worldMap.setDetail($('map-detail').value);
function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function toast(message, error = false) {
  const el = $('toast'); el.textContent = message; el.classList.toggle('error', error); el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, error ? Math.max(4200, message.length * 55) : 2200);
}
async function copyText(text, message = 'Copied') { try { await navigator.clipboard.writeText(text); toast(message); } catch { toast(text); } }
async function api(path, data) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }), obj = await r.json();
  if (!r.ok) throw Error(obj.error);
  return obj;
}
const narrow = () => matchMedia('(max-width: 860px)').matches;
function openPanel(name, keep = false) {
  const app = $('app');
  if (name === 'map' || (!keep && name === app.dataset.panel)) name = 'none';
  app.dataset.panel = name;
  document.querySelectorAll('.pane').forEach(p => { p.hidden = p.dataset.pane !== name; });
  document.querySelectorAll('[data-open]').forEach(b => b.classList.toggle('active', b.dataset.open === (name === 'none' ? 'map' : name)));
}

// ---- Find seeds: conditions ----------------------------------------------
// A condition is "at least `count` of this feature between `minRadius` and `radius` blocks" (mode within),
// or "none of this feature within `radius` blocks" (mode exclude). Distances run from the search origin,
// or, when `near` names another condition, from each match of that one ("a trial chamber within 300 of the village").
const condition = (kind, key, extra = {}) => ({ kind, key, radius: Number($('radius').value) || 1000, mode: 'within', minRadius: 0, count: 1, near: '', ...extra });
// Only a structure you want nearby, itself measured from the origin, can be measured from.
const canAnchor = f => f && f.kind === 'structure' && f.mode === 'within' && !f.near;
const anchorsFor = id => [...chosen.entries()].filter(([other, f]) => other !== id && canAnchor(f));
const isAnchor = id => [...chosen.values()].some(f => f.near === id);
// Older choosers added one AND condition per checkbox. Preserve the distance/count settings,
// but combine equivalent conditions into alternatives within one structure family.
function mergeFamilyConditions(family, force = false) {
  const keys = familyKeys(family), entries = [...chosen.entries()].filter(([, f]) => f.kind === 'structure' && keys.includes(f.key));
  if (!entries.length || (entries.length === 1 && entries[0][1].key === family)) return;
  const policy = f => JSON.stringify([f.radius, f.minRadius, f.count, f.mode, f.near || '']);
  if (!force && new Set(entries.map(([, f]) => policy(f))).size > 1) return;
  const base = entries.find(([, f]) => f.key === family)?.[1], next = { ...(base || entries[0][1]), key: family };
  delete next.id;
  for (const field of SUBCATEGORY_FILTERS) {
    const values = base ? base[field] : field === 'templates' ? [] : entries.map(([, f]) => field === 'variants' ? catalog.variantDetails[f.key] : f.key.startsWith(`${family}_`) && !f.key.includes('__') ? f.key.slice(family.length + 1) : null).filter(Boolean);
    const all = field === 'variants' ? familyVariants(family).map(k => catalog.variantDetails[k]) : field === 'templates' ? familyTemplates(family) : family === 'shipwrecks' ? catalog?.structurePlacements?.shipwrecks || [] : PORTAL_PLACEMENTS;
    if (!values?.length || all.every(v => values.includes(v))) delete next[field];
    else next[field] = [...new Set(values)];
  }
  const id = `structure:${family}`, oldIds = entries.map(([key]) => key);
  for (const old of oldIds) chosen.delete(old);
  chosen.set(id, next);
  for (const f of chosen.values()) if (oldIds.includes(f.near)) f.near = id;
}
function familyFilterDescription(f) {
  if (!f) return '';
  return [Array.isArray(f.variants) ? f.variants.length === 1 ? variantName(f.key, f.variants[0]) : f.variants.length ? `${f.variants.length} variants` : 'No variants selected' : '',
    Array.isArray(f.placements) ? f.placements.length ? f.placements.map(p => placementName(f.key, p)).join(' or ') : 'No placements selected' : '',
    Array.isArray(f.templates) ? f.key !== 'shipwrecks' ? f.templates.map(t => templateName(f.key, t)).join(' or ') || 'None selected' : f.templates.length === 1 ? shipTemplateName(f.templates[0]) : f.templates.length ? `${f.templates.length} templates` : 'No templates selected' : ''].filter(Boolean).join(' · ');
}
const conditionName = f => `${label(f.key)}${familyFilterDescription(f) ? ` (${familyFilterDescription(f)})` : ''}`;
// The starting seed is deliberately not remembered: left blank, every search starts from a new random seed.
// Whether Find searches many seeds or inside one; declared early because the buttons depend on it from the start.
let searchMode = 'seeds';
try { if (localStorage.getItem('seed-scout-search-mode') === 'world') searchMode = 'world'; } catch { }
// Conditions on the spawn itself; restored with the other settings just below.
const spawnRules = { biomeMode: 'any', biomes: [], slimeCount: 0, slimeRadius: 5 };
const spawnRulesActive = () => (spawnRules.biomeMode !== 'any' && spawnRules.biomes.length > 0) || spawnRules.slimeCount > 0;
function save() { queueEstimate(); localStorage.setItem('seed-scout-settings', JSON.stringify({ defaults: 2, fields: Object.fromEntries(fields.filter(k => k !== 'seed').map(k => [k, $(k).value])), chosen: [...chosen.values()], spawn: spawnRules })); }
try {
  const saved = JSON.parse(localStorage.getItem('seed-scout-settings'));
  if (saved?.spawn) Object.assign(spawnRules, { biomeMode: ['in', 'not'].includes(saved.spawn.biomeMode) ? saved.spawn.biomeMode : 'any', biomes: Array.isArray(saved.spawn.biomes) ? saved.spawn.biomes : [], slimeCount: Number(saved.spawn.slimeCount) || 0, slimeRadius: Number(saved.spawn.slimeRadius) || 5 });
  // The default seed budget rose from 100,000 to 1,000,000; a saved value that is just the old default follows it.
  if (saved && saved.defaults !== 2 && saved.fields.limit === '100000') delete saved.fields.limit;
  if (saved) { for (const [k, v] of Object.entries(saved.fields)) if ($(k) && k !== 'seed') $(k).value = v; for (const f of saved.chosen) chosen.set(`${f.kind}:${f.key}`, condition(f.kind, f.key, f)); }
} catch { }
function syncAnchor() {
  const custom = $('anchor').value === 'custom';
  $('coordinates').hidden = !custom;
  document.querySelectorAll('[data-anchor]').forEach(b => b.classList.toggle('active', b.dataset.anchor === $('anchor').value));
}
function renderFeatures() {
  if (!catalog) return;
  const filter = $('filter').value.trim().toLowerCase();
  const list = [...(kind === 'structure' ? catalog.sets.filter(rootStructure) : catalog.biomes)].filter(k => label(k).toLowerCase().includes(filter) || (kind === 'structure' && familyKeys(k).some(v => label(v).toLowerCase().includes(filter)))).sort((a, b) => label(a).localeCompare(label(b)));
  $('features').innerHTML = list.map(k => {
    if (kind === 'structure' && STRUCTURE_FAMILIES.includes(k)) {
      const count = familyKeys(k).filter(v => chosen.has(`structure:${v}`)).length;
      const filters = familyFilterDescription(chosen.get(`structure:${k}`));
      return `<div class="feature category-feature ${count ? 'selected' : ''}"><button type="button" class="category-toggle" data-category="${esc(k)}" aria-pressed="${count > 0}">${glyph('structure', k)}<span class="name">${esc(familyName(k))}<small>${esc(filters || (chosen.has(`structure:${k}`) || !count ? 'All variants' : `${count} selected`))}</small></span></button><button type="button" class="subcategory-arrow" data-subcategories="${esc(k)}" aria-label="Choose ${esc(familyName(k))} subcategories" title="Choose subcategories">${icon('chevron')}</button></div>`;
    }
    const selected = chosen.has(`${kind}:${k}`);
    return `<label class="feature ${selected ? 'selected' : ''}"><input type="checkbox" data-key="${esc(k)}" ${selected ? 'checked' : ''}>${glyph(kind, k)}<span class="name">${esc(label(k))}</span>${icon('check', 'tick')}</label>`;
  }).join('') || '<p class="loading">No matching features.</p>';
  $('kind-hint').textContent = kind === 'structure' ? 'Structures are confirmed with Minecraft’s own generation-start checks.' : 'Biomes are sampled every 32 blocks at surface height. Tiny patches can be missed.';
}
function renderChosen() {
  for (const f of chosen.values()) if (f.near && !canAnchor(chosen.get(f.near))) f.near = '';
  // Alternatives only make sense for a plain "near the origin" condition that nothing else is measured from.
  for (const [id, f] of chosen) if (f.or && (f.mode === 'exclude' || f.near || isAnchor(id))) delete f.or;
  $('selection-count').textContent = `${chosen.size} selected`;
  const number = (id, field, value, min, max, name) => `<input type="number" data-field="${field}" data-id="${esc(id)}" value="${value}" min="${min}" max="${max}" step="${field === 'count' ? 1 : 50}" aria-label="${name}">`;
  $('chosen').innerHTML = [...chosen.entries()].map(([id, f]) => {
    const avoid = f.mode === 'exclude', name = esc(conditionName(f)), anchors = isAnchor(id) ? [] : anchorsFor(id);
    const origin = !anchors.length ? '' : `<span class="origin"><span>${avoid ? 'of' : 'from'}</span><select data-near data-id="${esc(id)}" aria-label="What ${name} is measured from"><option value="">the search origin</option>${anchors.map(([other, a]) => `<option value="${esc(other)}" ${f.near === other ? 'selected' : ''}>${a.count > 1 ? 'each' : 'the'} ${esc(label(a.key).toLowerCase())}</option>`).join('')}</select></span>`;
    const rule = (avoid
      ? `<span>none within</span>${number(id, 'radius', f.radius, 32, 8000, `Distance to keep clear of ${name}`)}<span>blocks</span>`
      : `${f.kind === 'structure' ? `${number(id, 'count', f.count, 1, 10, `How many ${name}`)}<span>or more,</span>` : ''}${number(id, 'minRadius', f.minRadius, 0, 7968, `Minimum distance for ${name}`)}<span>to</span>${number(id, 'radius', f.radius, 32, 8000, `Maximum distance for ${name}`)}<span>blocks</span>`) + origin;
    const others = avoid || f.near || isAnchor(id) ? null : (f.or || []);
    const pick = (kind, keys) => keys.filter(k => !(kind === f.kind && k === f.key) && !others.some(o => o.kind === kind && o.key === k)).sort((a, b) => label(a).localeCompare(label(b))).map(k => `<option value="${kind}:${esc(k)}">${esc(label(k))}</option>`).join('');
    const either = !others ? '' : `<div class="criterion-or">${others.map((o, i) => `<span>or</span><span class="chip">${glyph(o.kind, o.key)}${esc(label(o.key))}<button data-or-remove="${i}" data-id="${esc(id)}" aria-label="Remove alternative ${esc(label(o.key))}">×</button></span>`).join('')}${others.length < 4 && catalog ? `<select data-or-add data-id="${esc(id)}" aria-label="Add an alternative to ${name}"><option value="">+ or…</option><optgroup label="Structures">${pick('structure', catalog.sets.filter(rootStructure))}</optgroup><optgroup label="Biomes">${pick('biome', catalog.biomes)}</optgroup></select>` : ''}</div>`;
    return `<div class="criterion ${avoid ? 'avoid' : ''}">
      <div class="criterion-top">${glyph(f.kind, f.key)}<span class="name">${name}</span>
        <span class="mini-seg" role="group" aria-label="Condition for ${name}"><button type="button" data-mode="within" data-id="${esc(id)}" class="${avoid ? '' : 'active'}">Near</button><button type="button" data-mode="exclude" data-id="${esc(id)}" class="${avoid ? 'active' : ''}">Avoid</button></span>
        <button class="icon-btn" data-remove="${esc(id)}" aria-label="Remove ${name}">${icon('x')}</button></div>
      <div class="criterion-rule">${rule}</div>${either}
    </div>`;
  }).join('') || '<p class="hint">Nothing selected yet. Tick a structure or biome above.</p>';
  syncButtons();
}
function syncButtons() {
  const emptyFilter = [...chosen.values()].some(f => SUBCATEGORY_FILTERS.some(field => f[field]?.length === 0));
  $('start').disabled = !catalog || state.running || state.world?.running || (searchMode === 'world' ? ![...chosen.values()].some(f => f.mode !== 'exclude') : (!chosen.size && !spawnRulesActive())) || emptyFilter;
  worldHint();
  $('inspect').disabled = !catalog || (!chosen.size && !spawnRulesActive()) || emptyFilter;
}
function updateConditionField(el) {
  const f = chosen.get(el.dataset.id); if (!f) return;
  const value = Math.round(Number(el.value) || 0);
  if (el.dataset.field === 'count') f.count = Math.max(1, Math.min(10, value));
  else if (el.dataset.field === 'radius') { f.radius = Math.max(32, Math.min(8000, value)); f.minRadius = Math.min(f.minRadius, f.radius - 32); }
  else f.minRadius = Math.max(0, Math.min(f.radius - 32, value));
}
function commitConditionFields() {
  // Read visible edits before a request or chooser rebuild, even if blur/change has not fired.
  const inputs = [...$('chosen').querySelectorAll('[data-field]')];
  // Apply the new maximum first, so the minimum is clamped against the visible range.
  inputs.sort((a, b) => Number(a.dataset.field === 'minRadius') - Number(b.dataset.field === 'minRadius'));
  for (const el of inputs) updateConditionField(el);
}
// ---- Conditions on the spawn itself ---------------------------------------
// The biome the world spawn is in, and slime chunks around the search origin. Both are tested before any feature.
function renderSpawnRules() {
  $('spawn-biome-mode').value = spawnRules.biomeMode;
  $('spawn-biome-pick').hidden = spawnRules.biomeMode === 'any';
  $('spawn-biome-list').innerHTML = spawnRules.biomes.map(b => `<span class="chip">${glyph('biome', b)}${esc(label(b))}<button data-spawn-biome="${esc(b)}" aria-label="Remove ${esc(label(b))}">×</button></span>`).join('');
  $('spawn-biome-add').innerHTML = `<option value="">Add a biome…</option>${(catalog?.biomes || []).filter(b => !spawnRules.biomes.includes(b)).sort((a, b) => label(a).localeCompare(label(b))).map(b => `<option value="${esc(b)}">${esc(label(b))}</option>`).join('')}`;
  $('slime-count').value = spawnRules.slimeCount; $('slime-radius').value = spawnRules.slimeRadius;
}
$('spawn-biome-mode').onchange = () => { spawnRules.biomeMode = $('spawn-biome-mode').value; renderSpawnRules(); syncButtons(); save(); };
$('spawn-biome-add').onchange = () => { const b = $('spawn-biome-add').value; if (b && spawnRules.biomes.length < 30) spawnRules.biomes.push(b); renderSpawnRules(); syncButtons(); save(); };
$('spawn-biome-list').onclick = e => { const b = e.target.closest('[data-spawn-biome]'); if (!b) return; spawnRules.biomes = spawnRules.biomes.filter(x => x !== b.dataset.spawnBiome); renderSpawnRules(); syncButtons(); save(); };
for (const id of ['slime-count', 'slime-radius']) $(id).onchange = () => {
  spawnRules.slimeRadius = Math.max(1, Math.min(8, Math.round(Number($('slime-radius').value) || 5)));
  spawnRules.slimeCount = Math.max(0, Math.min((2 * spawnRules.slimeRadius + 1) ** 2, Math.round(Number($('slime-count').value) || 0)));
  renderSpawnRules(); syncButtons(); save();
};
const request = () => {
  commitConditionFields();
  return { ...Object.fromEntries(fields.map(k => [k, $(k).value])), features: [...chosen.entries()].map(([id, f]) => ({ ...f, id, near: f.near || undefined })),
    ...(spawnRules.biomeMode !== 'any' && spawnRules.biomes.length ? { spawnBiomes: spawnRules.biomes, spawnBiomeMode: spawnRules.biomeMode } : {}),
    ...(spawnRules.slimeCount > 0 ? { slime: { count: spawnRules.slimeCount, radius: spawnRules.slimeRadius } } : {}) };
};

$('features').onchange = e => {
  const el = e.target.closest('[data-key]'); if (!el) return;
  const id = `${kind}:${el.dataset.key}`;
  if (el.checked) chosen.set(id, condition(kind, el.dataset.key)); else chosen.delete(id);
  el.closest('.feature').classList.toggle('selected', el.checked);
  renderChosen(); save();
};
$('features').onclick = e => {
  const arrow = e.target.closest('[data-subcategories]');
  if (arrow) { openSubcategories(arrow.dataset.subcategories, 'find'); return; }
  const button = e.target.closest('[data-category]'); if (!button) return;
  const family = button.dataset.category, keys = familyKeys(family);
  if (keys.some(key => chosen.has(`structure:${key}`))) {
    for (const key of keys) chosen.delete(`structure:${key}`);
  } else {
    if (chosen.size >= 12) { toast('Choose up to 12 search conditions.', true); return; }
    chosen.set(`structure:${family}`, condition('structure', family));
  }
  renderFeatures(); renderChosen(); save();
};

let subcategoryContext = null;
function openSubcategories(family, mode) {
  if (mode === 'find') { commitConditionFields(); mergeFamilyConditions(family, true); renderFeatures(); renderChosen(); save(); }
  subcategoryContext = { family, mode };
  $('subcategory-title').textContent = familyName(family);
  $('subcategory-hint').textContent = (mode === 'find' ? 'Selected variants are alternatives in one search condition. For portals, biome and placement must match the same portal.' : isPortalFamily(family) ? 'Choose which portals appear on the map. Biome and placement filters apply together.' : 'Choose which variants appear on the map.') + (isPortalFamily(family) ? ' Placement names are Minecraft generation types: swamp portals use “On ocean floor” even on dry land.' : '');
  if (family === 'shipwrecks') $('subcategory-hint').textContent = mode === 'find' ? 'Type, water placement and template must match the same ship. Floating requires a dry deck, water around the hull and no seabed contact. Placement is predicted from base terrain; ice and completed-world details may differ. These rare placements need wider searches.' : 'Choose ship types and templates. Water placement is checked when inspecting a ship or filtering a search.';
  renderSubcategories();
  $('subcategory-dialog').showModal();
}
function renderSubcategories() {
  const { family, mode } = subcategoryContext, config = mode === 'find' ? chosen.get(`structure:${family}`) : worldMap.features().find(f => f.key === family) || {};
  $('subcategory-options').classList.toggle('portal-options', isPortalFamily(family));
  const variants = familyVariants(family).map(key => ({ key, value: catalog.variantDetails[key], name: variantName(family, catalog.variantDetails[key]) }));
  // A family with one variant (igloos) has nothing to choose there.
  const groups = variants.length > 1 ? [{ title: isPortalFamily(family) ? 'Biome variants' : family === 'shipwrecks' ? 'Location types' : 'Variants', field: 'variants', options: variants }] : [];
  if (isPortalFamily(family)) groups.push({ title: 'Placements', field: 'placements', options: PORTAL_PLACEMENTS.filter(p => catalog?.sets.includes(`${family}_${p}`)).map(p => ({ key: `${family}_${p}`, value: p, name: label(p) })) });
  if (family === 'shipwrecks' && mode === 'find') groups.push({ title: 'Water placement (predicted)', field: 'placements', options: (catalog?.structurePlacements?.shipwrecks || []).map(p => ({ key: family, value: p, name: placementName(family, p) })) });
  // Map markers are only built for shipwrecks, so the other families' traits can filter a search but not a layer.
  const templates = mode === 'find' || family === 'shipwrecks' ? familyTemplates(family) : [];
  if (templates.length) groups.push({ title: templateTitle(family), field: 'templates', options: templates.map(t => ({ key: family, value: t, name: templateName(family, t) })) });
  const option = (name, key, field, value, checked) => `<label class="subcategory-option"><input type="checkbox" data-subkey="${esc(key)}" data-subfield="${field}" value="${esc(value)}" ${checked ? 'checked' : ''}><span>${esc(name)}</span></label>`;
  const selected = (field, value) => !!config && (!Array.isArray(config[field]) || (value === '*' ? groups.find(g => g.field === field).options.every(o => config[field].includes(o.value)) : config[field].includes(value)));
  $('subcategory-options').innerHTML = (mode === 'find' ? option(family === 'shipwrecks' ? 'Any type, placement or template' : templates.length ? `Any ${familyName(family).toLowerCase()}` : isPortalFamily(family) ? 'Any variant or placement' : 'Any variant', family, 'any', family, !!config && SUBCATEGORY_FILTERS.every(field => !config[field])) : '') + groups.map(g => `<fieldset><legend>${g.title}</legend>${option(`All ${g.title.toLowerCase()}`, family, g.field, '*', selected(g.field, '*'))}${g.options.map(o => option(o.name, o.key, g.field, o.value, selected(g.field, o.value))).join('')}</fieldset>`).join('');
}
$('subcategory-options').onchange = e => {
  const el = e.target.closest('[data-subkey]'); if (!el || !subcategoryContext) return;
  const { family, mode } = subcategoryContext;
  if (mode === 'find') {
    const id = `structure:${family}`, current = chosen.get(id), field = el.dataset.subfield;
    if (el.checked && !current && chosen.size >= 12) { el.checked = false; toast('Choose up to 12 search conditions.', true); return; }
    if (field === 'any') {
      if (el.checked) { const next = { ...(current || condition('structure', family)) }; for (const field of SUBCATEGORY_FILTERS) delete next[field]; chosen.set(id, next); }
      else chosen.delete(id);
    } else {
      const options = [...$('subcategory-options').querySelectorAll(`[data-subfield="${field}"]`)].filter(o => o.value !== '*');
      const values = el.value === '*' ? (el.checked ? options.map(o => o.value) : []) : options.filter(o => o.checked).map(o => o.value);
      const next = { ...(current || condition('structure', family)) };
      if (values.length === options.length) delete next[field]; else next[field] = values;
      chosen.set(id, next);
    }
    renderFeatures(); renderChosen(); save();
  } else {
    const field = el.dataset.subfield, options = [...$('subcategory-options').querySelectorAll(`[data-subfield="${field}"]`)].filter(o => o.value !== '*');
    const config = worldMap.features().find(f => f.key === family);
    const values = el.value === '*' ? (el.checked ? options.map(o => o.value) : []) : options.filter(o => o.checked).map(o => o.value);
    worldMap.setFeature(family, { [field]: values, on: values.length > 0 && SUBCATEGORY_FILTERS.every(other => other === field || config[other]?.length !== 0) });
    presetChanged(); renderLayers();
  }
  renderSubcategories();
  $('subcategory-options').querySelector(`[data-subfield="${CSS.escape(el.dataset.subfield)}"][value="${CSS.escape(el.value)}"]`)?.focus({ preventScroll: true });
};
for (const id of ['subcategory-close', 'subcategory-done']) $(id).onclick = () => $('subcategory-dialog').close();
$('subcategory-dialog').onclick = e => { if (e.target === e.currentTarget) { const box = e.currentTarget.getBoundingClientRect(); if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) e.currentTarget.close(); } };
$('chosen').onchange = e => {
  const near = e.target.closest('[data-near]');
  if (near) { chosen.get(near.dataset.id).near = near.value; renderChosen(); save(); return; }
  const or = e.target.closest('[data-or-add]');
  if (or) {
    if (or.value) { const f = chosen.get(or.dataset.id), [kind, key] = or.value.split(':'); f.or = [...(f.or || []), { kind, key }].slice(0, 4); }
    renderChosen(); save(); return;
  }
  const el = e.target.closest('[data-field]'); if (!el) return;
  updateConditionField(el);
  renderChosen(); save();
};
$('chosen').onclick = e => {
  const alternative = e.target.closest('[data-or-remove]');
  if (alternative) { const f = chosen.get(alternative.dataset.id); f.or.splice(Number(alternative.dataset.orRemove), 1); if (!f.or.length) delete f.or; renderChosen(); save(); return; }
  const remove = e.target.closest('[data-remove]'), mode = e.target.closest('[data-mode]');
  if (remove) { chosen.delete(remove.dataset.remove); renderChosen(); renderFeatures(); save(); }
  else if (mode) {
    const f = chosen.get(mode.dataset.id);
    f.mode = mode.dataset.mode;
    if (f.mode === 'exclude') { f.minRadius = 0; f.count = 1; }
    renderChosen(); save();
  }
};
$('usage').addEventListener('change', () => {
  if ($('usage').value === 'custom') return showUsage();
  const plan = usagePlan($('usage').value);
  $('threads').value = String(plan.threads); $('mapWorkers').value = String(plan.mapWorkers);
  save(); setMapWorkers(plan.mapWorkers);
});
$('mapWorkers').addEventListener('change', () => { showUsage(); setMapWorkers($('mapWorkers').value); });
$('threads').addEventListener('change', showUsage);
for (const f of fields) $(f).addEventListener('change', () => {
  if (f === 'radius') { for (const entry of chosen.values()) { entry.radius = Number($('radius').value); entry.minRadius = Math.min(entry.minRadius, entry.radius - 32); } renderChosen(); }
  syncAnchor(); save();
});
document.querySelectorAll('[data-anchor]').forEach(el => el.onclick = () => { $('anchor').value = el.dataset.anchor; $('anchor').dispatchEvent(new Event('change')); });
document.querySelectorAll('[data-kind]').forEach(el => el.onclick = () => {
  kind = el.dataset.kind;
  document.querySelectorAll('[data-kind]').forEach(b => b.classList.toggle('active', b === el));
  $('features').scrollTop = 0; renderFeatures();
});
$('filter').oninput = renderFeatures;
document.querySelectorAll('[data-preset]').forEach(el => el.onclick = () => {
  if (!catalog) return;
  chosen.clear();
  const pair = el.dataset.preset === 'starter' ? ['villages', 'cherry_grove'] : el.dataset.preset === 'island' ? ['villages', 'mushroom_fields'] : ['villages', 'trial_chambers'];
  for (const key of pair) { const k = catalog.sets.includes(key) ? 'structure' : 'biome'; chosen.set(`${k}:${key}`, condition(k, key)); }
  renderFeatures(); renderChosen(); save();
});

// Seeds are tried in order from the starting seed. A blank starting seed picks a random one each time;
// resuming continues from where the last run stopped without changing what is typed in the field.
async function startSearch(fromSeed) {
  try {
    const payload = request();
    save();
    if (window.Notification?.permission === 'default') Notification.requestPermission().catch(() => { });
    const response = await api('/api/start', { ...payload, rareThreshold: Number($('rare-threshold').value) || 100000, useCatalogue: $('rare-first').checked, ...(fromSeed ? { seed: fromSeed } : {}) });
    state.running = true; manualResults = []; selectedSeed = null;
    notice(`Searching from seed ${response.seed}${$('seed').value.trim() || fromSeed ? '' : ' (picked at random)'}.`);
    openPanel('results', true);
    await poll();
  } catch (e) { notice(e.message, true); }
}
// ---- Searching inside one seed --------------------------------------------
// Instead of many seeds near their spawn: every place in one seed where the conditions hold, measured from the
// rarest structure asked for, nearest to the origin first and out to the world border if left running.
const WORLD_EDGE = 29999984;
function syncSearchMode() {
  const world = searchMode === 'world';
  $('find-body').classList.toggle('world-mode', world);
  document.querySelectorAll('[data-search-mode]').forEach(b => b.classList.toggle('active', b.dataset.searchMode === searchMode));
  $('origin-title').textContent = world ? 'Nearest to' : 'Search around';
  $('start').lastChild.textContent = world ? 'Search this seed' : 'Start searching';
  if (world && !$('world-seed').value.trim()) $('world-seed').value = worldMap.seed() || state.world?.seed || '';
  worldHint(); syncButtons();
}
function worldHint() {
  if (searchMode !== 'world') return;
  const wanted = [...chosen.values()].filter(f => f.mode !== 'exclude');
  $('world-hint').textContent = !wanted.length ? 'Choose what to look for below.'
    : `Finds every place in this seed with ${wanted.map(f => label(f.key).toLowerCase()).join(', ')}${[...chosen.values()].some(f => f.mode === 'exclude') ? ' and none of what you avoid' : ''}. `
      + (chosen.size > 1 ? 'The rarest structure in the list is the place; the other distances are measured from it, not from spawn. ' : '')
      + ([...chosen.values()].some(f => f.kind === 'structure' && f.mode !== 'exclude' && f.count > 1) ? 'A structure with a count above 1 is looked for as a group: that many within its distance of one of them. ' : wanted.some(f => f.kind === 'structure') ? 'Raise the count of a structure to look for groups of it. ' : '')
      + 'Places come nearest first. The whole world is 60 million blocks across, so reaching the border can take days; you can stop and keep searching later.';
}
document.querySelectorAll('[data-search-mode]').forEach(b => { b.onclick = () => { searchMode = b.dataset.searchMode; try { localStorage.setItem('seed-scout-search-mode', searchMode); } catch { } syncSearchMode(); }; });
async function startWorldSearch(resume = false) {
  try {
    const wanted = request();
    for (const key of ['spawnBiomes', 'spawnBiomeMode', 'slime']) delete wanted[key];
    const payload = resume ? { resume: true, threads: $('threads').value, maxMatches: Number($('world-max').value) || 50 }
      : { ...wanted, seed: $('world-seed').value.trim(), range: Number($('world-range').value), maxMatches: Number($('world-max').value) || 50, threads: $('threads').value };
    if (window.Notification?.permission === 'default') Notification.requestPermission().catch(() => { });
    await api('/api/world-start', payload);
    notice(resume ? 'Searching further out in the same seed.' : `Searching inside seed ${payload.seed}.`);
    openPanel('results', true);
    await poll();
  } catch (e) { notice(e.message, true); toast(e.message, true); }
}
$('world-stop').onclick = async () => { try { await api('/api/world-stop', {}); $('world-stop').disabled = true; } catch (e) { toast(e.message, true); } };
$('world-resume').onclick = () => startWorldSearch(true);
$('world-clear').onclick = async () => { try { await api('/api/world-clear', {}); await poll(); } catch (e) { toast(e.message, true); } };
const longDuration = seconds => seconds < 5400 ? duration(seconds) : seconds < 172800 ? `${(seconds / 3600).toFixed(1)} hours` : `${(seconds / 86400).toFixed(1)} days`;
let worldSignature = '', worldSpawn = {};
function renderWorld() {
  const w = state.world || {}, places = w.places || [], shown = w.running || places.length > 0 || !!w.request;
  $('world-results').hidden = !shown;
  if (!shown) return;
  $('world-title').textContent = `Places in seed ${w.seed}`;
  $('world-count').textContent = `${fmt(places.length)} found`;
  const range = Math.min(w.range || WORLD_EDGE, WORLD_EDGE), covered = Math.min(w.covered || 0, range), share = (covered / range) ** 2;
  const left = w.running && share > 0 && share < 1 && w.seconds > 5 ? ` · about ${longDuration(w.seconds * (1 - share) / share)} to reach ${range >= WORLD_EDGE ? 'the world border' : `${fmt(range)} blocks`} at this speed` : '';
  $('world-progress').textContent = (w.anchor ? `Every ${label(w.anchor.key).toLowerCase()}${(w.request?.features?.length || 1) > 1 ? ' with your other conditions around it' : ''}. ` : '')
    + (w.complete ? `Searched everything within ${fmt(range)} blocks.` : `${covered ? `Covered ${fmt(covered)} blocks in every direction` : 'Still within the first 2,048 blocks'}${share >= .0001 ? ` (${(share * 100).toFixed(share < .01 ? 2 : 1)}% of the area)` : ''} in ${longDuration(w.seconds || 0)}${left}.`)
    + (w.error ? ` ${w.error}` : '');
  $('world-bar').hidden = !w.running; $('world-bar').firstElementChild.style.width = `${Math.max(1, share * 100)}%`;
  $('world-stop').hidden = !w.running; if (!w.running) $('world-stop').disabled = false;
  $('world-resume').hidden = w.running || w.complete || !w.request; $('world-clear').hidden = w.running;
  const signature = `${w.seed}:${places.length}:${places[0]?.x}:${places[places.length - 1]?.x}`;
  if (signature === worldSignature) return;
  worldSignature = signature;
  $('places').innerHTML = places.slice(0, 500).map((p, i) => `<article class="result place" data-place="${i}" tabindex="0" role="button" aria-label="Show this place on the map">
      <div class="result-top"><code>X ${p.x} · Z ${p.z}</code><span>${fmt(p.distance)} blocks away</span></div>
      <div class="chips">${p.features.map(f => `<span class="chip">${featureChip(f).replace(/<b>0<\/b>blocks$/, '')}</span>`).join('')}</div>
    </article>`).join('') || (w.running ? '<p class="hint">Nothing yet. Places appear here as they are found.</p>' : '<p class="hint">No place matched in the area searched.</p>');
}
async function openPlace(place) {
  const w = state.world;
  try {
    const base = worldSpawn[w.seed] ||= await api('/api/open', { seed: w.seed, x: 0, z: 0 });
    const result = { ...base, seed: w.seed, anchorX: place.x, anchorZ: place.z, features: place.features.map(f => ({ ...f })) };
    manualResults = manualResults.filter(r => r.seed !== result.seed); manualResults.unshift(result);
    selectSeed(result); worldMap.jump(place.x, place.z, 2);
    if (narrow()) openPanel('map');
  } catch (e) { toast(e.message, true); }
}
$('places').onclick = e => { const card = e.target.closest('[data-place]'); if (card) openPlace(state.world.places[Number(card.dataset.place)]); };
$('places').onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-place]')) { e.preventDefault(); e.target.click(); } };
$('start').onclick = () => searchMode === 'world' ? startWorldSearch() : startSearch();
async function stopSearch() {
  try { await api('/api/stop', {}); notice('Stopping after the current checks…'); $('stop').disabled = $('stop-results').disabled = true; }
  catch (e) { notice(e.message, true); toast(e.message, true); }
}
function resumeSearch() { if (state.nextSeed) startSearch(state.nextSeed); }
$('stop').onclick = $('stop-results').onclick = stopSearch;
$('resume').onclick = $('resume-results').onclick = resumeSearch;
$('inspect').onclick = async () => {
  const seed = $('inspect-seed').value.trim();
  if (!seed) return notice('Enter a numeric Minecraft seed to check.', true);
  $('inspect').disabled = true; notice('Checking your conditions…');
  try {
    const result = await api('/api/inspect', { ...request(), seed });
    if (!result.match) notice('That seed does not meet these conditions.');
    else { manualResults = manualResults.filter(r => r.seed !== result.seed); manualResults.unshift(result); selectSeed(result); notice('Seed meets your conditions.'); }
  } catch (e) { notice(e.message, true); } finally { syncButtons(); }
};

// ---- Results -------------------------------------------------------------
// Chip text for a matched feature: distance from the origin, or from the match it was measured from.
// What a built structure turned out to be, beyond its type: read from its pieces by the engine.
const builtFact = f => f.zombie ? 'Abandoned (zombie)' : f.basement === true ? 'With basement' : f.basement === false ? 'No basement' : f.ruins > 1 ? `Cluster of ${f.ruins}` : f.ruins === 1 ? 'Single ruin' : '';
const featureChip = f => `${glyph(f.kind, f.key)}${esc(label(f.key))}${f.zombie || f.basement || f.ruins > 1 ? `<i>${esc(builtFact(f).toLowerCase())}</i>` : ''}<b>${fmt(f.distance)}</b>${f.near ? `from ${esc(label(f.near.key).toLowerCase())}` : 'blocks'}`;
const allResults = () => [...manualResults, ...(state.results || [])].filter((r, i, a) => a.findIndex(x => x.seed === r.seed) === i);
function selectSeed(result) { selectedSeed = result.seed; renderResults(); worldMap.show(result); }
async function openSeed(seed) {
  seed = seed.trim();
  if (!/^-?\d+$/.test(seed)) return toast('Enter a numeric seed, for example 123 or -4172144997902289642.', true);
  const known = allResults().find(r => r.seed === String(BigInt(seed)));
  try {
    const r = known || await api('/api/open', { seed, x: 0, z: 0 });
    if (!known) { manualResults = manualResults.filter(v => v.seed !== r.seed); manualResults.unshift(r); }
    selectSeed(r); openPanel(narrow() ? 'map' : 'layers', true);
  } catch (e) { toast(e.message, true); }
}
$('open-form').onsubmit = e => { e.preventDefault(); openSeed($('open-seed').value); };
$('export').onclick = async () => {
  try {
    const result = await api('/api/export', { results: allResults() });
    toast('Export saved to seed-scout/runtime/exported-results.json');
    const a = document.createElement('a'); a.href = result.url; a.download = 'seed-scout-results.json'; a.click();
  } catch (e) { toast(e.message, true); }
};
// The nearest match of one condition in a result, for sorting by that feature alone.
const nearest = (result, key) => Math.min(Infinity, ...result.features.filter(f => f.key === key).map(f => f.distance));
function renderResults() {
  let results = allResults();
  // Results arrive closest overall first; with several conditions they can also be ordered by one of them.
  const keys = [...new Set(results.flatMap(r => r.features.map(f => f.key)))], sort = $('results-sort');
  if (sort.dataset.keys !== keys.join()) {
    const chosen = sort.value;
    sort.dataset.keys = keys.join();
    sort.innerHTML = `<option value="">Closest overall</option>${keys.map(k => `<option value="${esc(k)}">Nearest ${esc(label(k).toLowerCase())}</option>`).join('')}`;
    sort.value = keys.includes(chosen) ? chosen : '';
  }
  $('results-sort-row').hidden = results.length < 2 || keys.length < 2;
  if (sort.value && !$('results-sort-row').hidden) results = [...results].sort((a, b) => nearest(a, sort.value) - nearest(b, sort.value));
  if (results.length && !results.some(r => r.seed === selectedSeed)) { selectedSeed = results[0].seed; worldMap.show(results[0]); }
  if (!results.length) { worldMap.clear(); selectedSeed = null; }
  const badge = $('results-badge'); badge.hidden = !results.length; badge.textContent = results.length;
  $('export').disabled = !results.length;
  // Polling calls this every second; only rebuild the list when it actually changed.
  const signature = results.map(r => `${r.seed}:${r.features.length}:${savedEntry(r.seed) ? 1 : 0}`).join('|') + `#${selectedSeed}`;
  // (The order is part of the signature, so choosing another sort rebuilds the list.)
  if (signature === resultsSignature) return;
  resultsSignature = signature;
  $('results').innerHTML = results.map(r => {
    const manual = manualResults.some(m => m.seed === r.seed);
    return `<article class="result ${r.seed === selectedSeed ? 'active' : ''}" data-seed="${esc(r.seed)}" tabindex="0" role="button" aria-label="Open seed ${esc(r.seed)} on the map">
      <div class="result-top"><code>${esc(r.seed)}</code><span class="card-actions"><button class="icon-btn ${savedEntry(r.seed) ? 'active' : ''}" data-save="${esc(r.seed)}" title="${savedEntry(r.seed) ? 'Saved. Show it in Saved seeds' : 'Save this seed with notes'}" aria-label="Save seed ${esc(r.seed)}">${icon('bookmark')}</button><button class="btn small" data-copy="${esc(r.seed)}">${icon('copy')}Copy</button></span></div>
      <div class="chips">${r.features.map((f, i) => `<button class="chip" data-feature="${i}" title="Show this ${esc(label(f.key).toLowerCase())} on the map">${featureChip(f)}</button>`).join('') || '<span class="chip plain">Opened without search conditions</span>'}</div>
      <div class="result-meta">${icon('spawn')}Spawn ${r.spawnX}, ${r.spawnZ}${r.spawnBiome ? ` in ${esc(label(r.spawnBiome).toLowerCase())}` : ''}${r.slimeChunks != null ? ` · ${r.slimeChunks} slime chunks nearby` : ''}${r.anchorX !== r.spawnX || r.anchorZ !== r.spawnZ ? ` · measured from ${r.anchorX}, ${r.anchorZ}` : ''}${manual ? ' · added by you' : ''}${r.fromCatalogue ? ' · from your catalogue' : ''}</div>
    </article>`;
  }).join('') || `<div class="empty">${icon('list')}<h4>No worlds yet</h4><p>Matching seeds appear here as they’re found. Distances are in blocks.</p></div>`;
}
$('results').onclick = e => {
  const copy = e.target.closest('[data-copy]');
  if (copy) return copyText(copy.dataset.copy, 'Seed copied');
  const keep = e.target.closest('[data-save]');
  if (keep) return saveSeed(allResults().find(r => r.seed === keep.dataset.save));
  const card = e.target.closest('[data-seed]'); if (!card) return;
  const result = allResults().find(r => r.seed === card.dataset.seed), chip = e.target.closest('[data-feature]');
  selectSeed(result);
  if (chip) worldMap.focus(result.features[Number(chip.dataset.feature)]);
  if (narrow()) openPanel('map');
};
$('results-sort').onchange = renderResults;
$('results').onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-seed]')) { e.preventDefault(); e.target.click(); } };

// ---- Saved seeds ---------------------------------------------------------
// Kept on disk by the app (saved-seeds.json), so they survive closing the browser: the seed, a note,
// the search result it came from and the map position it was saved at.
let savedSeeds = [], noteTimer = 0, savedTag = '';
const savedEntry = seed => savedSeeds.find(s => s.seed === seed);
async function loadSaved() {
  try { savedSeeds = (await (await fetch('/api/saved')).json()).seeds || []; } catch { }
  renderSaved();
}
async function saveSeed(result) {
  if (!result) return;
  const already = savedEntry(result.seed), open = worldMap.seed() === result.seed;
  try {
    if (!already) savedSeeds = (await api('/api/saved', { seed: result.seed, result, ...(open ? { view: worldMap.view() } : {}) })).seeds;
    renderSaved(); renderResults(); renderCatalogue(); openPanel('saved', true); document.querySelector('[data-library="seeds"]').click();
    const card = document.querySelector(`[data-saved="${CSS.escape(result.seed)}"]`);
    card?.scrollIntoView({ block: 'nearest' });
    if (!already) { card?.querySelector('textarea').focus(); toast('Seed saved. Add a note if you like.'); }
  } catch (e) { toast(e.message, true); }
}
async function openSaved(entry) {
  try {
    const result = entry.result || await api('/api/open', { seed: entry.seed, x: 0, z: 0 });
    manualResults = manualResults.filter(v => v.seed !== result.seed); manualResults.unshift(result);
    selectSeed(result);
    if (entry.view) worldMap.jump(entry.view.x, entry.view.z, entry.view.bpp);
    if (narrow()) openPanel('map');
  } catch (e) { toast(e.message, true); }
}
// Everything worth passing on about a saved seed, as plain text for a message or a notes file.
function seedCard(entry) {
  const r = entry.result, version = r?.version || catalog?.version || '';
  return [`Minecraft seed ${entry.seed}${version ? ` · ${versionName(version)}` : ''}`,
    r ? `Spawn: X ${r.spawnX}, Z ${r.spawnZ}` : '',
    ...(r?.features || []).map(f => `${label(f.key)}${builtFact(f) ? ` (${builtFact(f).toLowerCase()})` : ''}: X ${f.x}, Y ${f.y}, Z ${f.z} · ${fmt(f.distance)} blocks from ${f.near ? `the ${label(f.near.key).toLowerCase()}` : 'the origin'}`),
    entry.view ? `Saved view: X ${Math.round(entry.view.x)}, Z ${Math.round(entry.view.z)}` : '',
    entry.tags?.length ? `Tags: ${entry.tags.join(', ')}` : '',
    entry.note?.trim() ? `Notes: ${entry.note.trim()}` : '',
    'Found with Seed Scout'].filter(Boolean).join('\n');
}
function savedMatches(entry) {
  const words = $('saved-search').value.trim().toLowerCase();
  if (savedTag && !(entry.tags || []).includes(savedTag)) return false;
  if (!words) return true;
  const text = [entry.seed, entry.note || '', ...(entry.tags || []), ...(entry.result?.features || []).map(f => label(f.key))].join(' ').toLowerCase();
  return words.split(/\s+/).every(word => text.includes(word));
}
function renderSaved() {
  const open = worldMap.seed();
  const tags = [...new Set(savedSeeds.flatMap(s => s.tags || []))].sort();
  if (savedTag && !tags.includes(savedTag)) savedTag = '';
  $('saved-filter').hidden = savedSeeds.length < 4 && !tags.length;
  $('saved-tags').innerHTML = tags.map(t => `<button class="tag ${t === savedTag ? 'active' : ''}" data-filter-tag="${esc(t)}">${esc(t)}</button>`).join('');
  const shown = savedSeeds.filter(savedMatches);
  $('saved-badge').hidden = !savedSeeds.length; $('saved-badge').textContent = savedSeeds.length;
  $('save-current').hidden = !open || !!savedEntry(open);
  $('chip-save').classList.toggle('active', !!savedEntry(open));
  $('chip-save').title = savedEntry(open) ? 'Saved. Show it in Saved seeds' : 'Save this seed with notes';
  $('saved-list').innerHTML = shown.map(s => `<article class="result saved ${s.seed === open ? 'active' : ''}" data-saved="${esc(s.seed)}">
      <div class="result-top"><code>${esc(s.seed)}</code><span class="card-actions"><button class="icon-btn" data-copy="${esc(s.seed)}" title="Copy seed" aria-label="Copy seed">${icon('copy')}</button><button class="icon-btn" data-card title="Copy a text card: seed, version, coordinates, tags and notes" aria-label="Copy a text card for this seed">${icon('download')}</button><button class="icon-btn" data-forget title="Remove from saved seeds" aria-label="Remove from saved seeds">${icon('trash')}</button><button class="btn small primary" data-restore>${s.seed === open ? 'Go to saved view' : 'Open'}</button></span></div>
      ${s.result?.features?.length ? `<div class="chips">${s.result.features.map(f => `<span class="chip">${featureChip(f)}</span>`).join('')}</div>` : ''}
      <div class="tags">${(s.tags || []).map(t => `<span class="tag">${esc(t)}<button data-untag="${esc(t)}" aria-label="Remove tag ${esc(t)}">×</button></span>`).join('')}<input data-tag maxlength="24" placeholder="+ tag" aria-label="Add a tag to seed ${esc(s.seed)}"></div>
      <textarea data-note rows="3" maxlength="4000" placeholder="Notes: why this seed, where to build, what to visit…" aria-label="Notes for seed ${esc(s.seed)}">${esc(s.note || '')}</textarea>
      <div class="result-meta"><span>Saved ${esc(s.saved || '')}${s.view ? ` · view at X ${Math.round(s.view.x)}, Z ${Math.round(s.view.z)}` : ''}</span>${s.seed === open ? '<button class="link" data-reposition>Save current view</button>' : ''}<em data-state></em></div>
    </article>`).join('') || (savedSeeds.length ? `<div class="empty">${icon('search')}<h4>No saved seed matches</h4><p>Clear the filter to see all ${savedSeeds.length}.</p></div>` : '') || `<div class="empty">${icon('bookmark')}<h4>No saved seeds yet</h4><p>Open a seed and press the bookmark next to its number, or use the bookmark on a found world.</p></div>`;
}
async function saveNote(card) {
  const seed = card.dataset.saved, state = card.querySelector('[data-state]');
  try { savedSeeds = (await api('/api/saved', { seed, note: card.querySelector('textarea').value })).seeds; state.textContent = 'Note saved'; }
  catch (e) { state.textContent = ''; toast(e.message, true); }
}
$('saved-list').oninput = e => {
  const card = e.target.closest('[data-saved]'); if (!e.target.matches('[data-note]')) return;
  card.querySelector('[data-state]').textContent = 'Saving…';
  clearTimeout(noteTimer); noteTimer = setTimeout(() => saveNote(card), 700);
};
async function setTags(entry, tags) {
  try { savedSeeds = (await api('/api/saved', { seed: entry.seed, tags })).seeds; renderSaved(); }
  catch (e) { toast(e.message, true); }
}
$('saved-list').onkeydown = e => {
  if (e.key !== 'Enter' || !e.target.matches('[data-tag]')) return;
  e.preventDefault();
  const entry = savedEntry(e.target.closest('[data-saved]').dataset.saved), tag = e.target.value.trim().toLowerCase();
  if (tag) setTags(entry, [...new Set([...(entry.tags || []), tag])]).then(() => document.querySelector(`[data-saved="${CSS.escape(entry.seed)}"] [data-tag]`)?.focus());
};
$('saved-search').oninput = renderSaved;
$('saved-tags').onclick = e => { const tag = e.target.closest('[data-filter-tag]'); if (!tag) return; savedTag = savedTag === tag.dataset.filterTag ? '' : tag.dataset.filterTag; renderSaved(); };
$('saved-list').onclick = async e => {
  const card = e.target.closest('[data-saved]'); if (!card) return;
  const entry = savedEntry(card.dataset.saved), copy = e.target.closest('[data-copy]'), forget = e.target.closest('[data-forget]'), untag = e.target.closest('[data-untag]');
  if (copy) return copyText(copy.dataset.copy, 'Seed copied');
  if (untag) return setTags(entry, (entry.tags || []).filter(t => t !== untag.dataset.untag));
  if (e.target.closest('[data-card]')) return copyText(seedCard(entry), 'Seed card copied');
  if (e.target.closest('[data-restore]')) return openSaved(entry);
  try {
    if (e.target.closest('[data-reposition]')) { savedSeeds = (await api('/api/saved', { seed: entry.seed, view: worldMap.view() })).seeds; renderSaved(); toast('Saved view updated'); }
    else if (forget) {
      // Removing a seed also removes its note, so it takes a second click.
      if (!forget.classList.contains('armed')) { forget.classList.add('armed'); forget.title = 'Click again to remove this seed and its note'; toast('Click the bin again to remove this seed and its note'); return; }
      savedSeeds = (await api('/api/saved-delete', { seed: entry.seed })).seeds; renderSaved(); renderResults();
    }
  } catch (error) { toast(error.message, true); }
};
$('save-open').onclick = $('chip-save').onclick = () => saveSeed(worldMap.current());
worldMap.on('open', renderSaved);
worldMap.on('close', renderSaved);

// ---- Rare finds ----------------------------------------------------------
// Searches that needed many seeds per match are kept by the app (catalogue.db) with their conditions and seeds.
let rareFinds = [];
try { $('rare-threshold').value = localStorage.getItem('seed-scout-rare') || 100000; $('rare-first').checked = localStorage.getItem('seed-scout-rare-first') !== 'off'; } catch { }
$('rare-first').onchange = e => localStorage.setItem('seed-scout-rare-first', e.target.checked ? 'on' : 'off');
$('rare-threshold').onchange = e => { e.target.value = Math.max(100, Math.min(100000000, Math.round(Number(e.target.value) || 100000))); localStorage.setItem('seed-scout-rare', e.target.value); };
document.querySelectorAll('[data-library]').forEach(el => el.onclick = () => {
  document.querySelectorAll('[data-library]').forEach(b => b.classList.toggle('active', b === el));
  document.querySelectorAll('[data-library-view]').forEach(v => { v.hidden = v.dataset.libraryView !== el.dataset.library; });
});
// One condition in words, e.g. "2+ villages within 1,000" or "no outpost within 400 of the village".
function describe(f, all) {
  const name = label(f.key).toLowerCase(), parent = f.near && all.find(o => o.id === f.near), where = parent ? ` of the ${label(parent.key).toLowerCase()}` : '';
  if (f.mode === 'exclude') return `no ${name} within ${fmt(f.radius)}${where}`;
  return `${f.count > 1 ? `${f.count}+ ` : ''}${name} ${f.minRadius ? `${fmt(f.minRadius)}–${fmt(f.radius)} away` : `within ${fmt(f.radius)}`}${where}`;
}
async function loadCatalogue() {
  try { rareFinds = (await (await fetch('/api/catalogue')).json()).finds || []; } catch { }
  renderCatalogue();
}
function renderCatalogue() {
  $('rare-count').textContent = rareFinds.length;
  $('rare-export').disabled = !rareFinds.length;
  $('rare-list').innerHTML = rareFinds.map(f => {
    const c = f.conditions, origin = c.anchor === 'custom' ? `around X ${c.x}, Z ${c.z}` : 'around spawn';
    return `<article class="result rare" data-find="${f.id}">
      <div class="result-top"><strong>${f.seedsPerMatch ? `About 1 in ${fmt(f.seedsPerMatch)}` : 'Rarity unknown'}</strong><span class="card-actions"><button class="icon-btn" data-forget-find title="Remove from the catalogue" aria-label="Remove from the catalogue">${icon('trash')}</button><button class="btn small" data-reuse title="Load these conditions into Find">Use conditions</button></span></div>
      <p class="rare-text">${esc(c.features.map(x => describe(x, c.features)).join(' · '))}, ${origin}</p>
      <div class="result-meta"><span>${fmt(f.seeds.length)} seed${f.seeds.length === 1 ? '' : 's'} · ${fmt(f.tested)} checked${f.matches < 5 ? ' · rough estimate' : ''} · ${esc(f.version)}${f.imported ? ' · includes imported counts' : ''}</span></div>
      <details><summary>Show seeds</summary>${f.seeds.map((r, i) => `<div class="rare-seed"><code>${esc(r.seed)}</code><span class="card-actions"><button class="icon-btn ${savedEntry(r.seed) ? 'active' : ''}" data-keep="${i}" title="Save this seed with notes" aria-label="Save seed ${esc(r.seed)}">${icon('bookmark')}</button><button class="icon-btn" data-copy="${esc(r.seed)}" title="Copy seed" aria-label="Copy seed">${icon('copy')}</button><button class="btn small primary" data-show="${i}">Open</button></span></div>`).join('')}</details>
    </article>`;
  }).join('') || `<div class="empty">${icon('gem')}<h4>No rare finds yet</h4><p>Nothing to do here: when a search turns out to be rare, it is added on its own.</p></div>`;
}
$('rare-list').onclick = async e => {
  const card = e.target.closest('[data-find]'); if (!card) return;
  const find = rareFinds.find(f => String(f.id) === card.dataset.find), copy = e.target.closest('[data-copy]'), show = e.target.closest('[data-show]'), keep = e.target.closest('[data-keep]'), forget = e.target.closest('[data-forget-find]');
  if (copy) return copyText(copy.dataset.copy, 'Seed copied');
  if (keep) return saveSeed(find.seeds[Number(keep.dataset.keep)]);
  if (show) {
    const result = find.seeds[Number(show.dataset.show)];
    manualResults = manualResults.filter(v => v.seed !== result.seed); manualResults.unshift(result);
    selectSeed(result); if (narrow()) openPanel('map'); return;
  }
  if (e.target.closest('[data-reuse]')) {
    const c = find.conditions;
    chosen.clear();
    for (const f of c.features) chosen.set(f.id || `${f.kind}:${f.key}`, condition(f.kind, f.key, { ...f, near: f.near || '' }));
    $('anchor').value = c.anchor; $('x').value = c.x || 0; $('z').value = c.z || 0; $('biomeMode').value = c.biomeMode; $('cluster').value = c.cluster;
    syncAnchor(); renderChosen(); renderFeatures(); save(); openPanel('find', true); toast('Conditions loaded'); return;
  }
  if (forget) {
    if (!forget.classList.contains('armed')) { forget.classList.add('armed'); toast('Click the bin again to remove this find and its seeds'); return; }
    try { rareFinds = (await api('/api/catalogue-delete', { id: find.id })).finds; renderCatalogue(); } catch (error) { toast(error.message, true); }
  }
};
$('rare-export').onclick = () => { const a = document.createElement('a'); a.href = '/api/catalogue-export'; a.download = 'seed-scout-catalogue.json'; a.click(); };
$('rare-import').onclick = () => $('rare-file').click();
$('rare-file').onchange = async e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  toast('Importing and re-checking every seed…');
  try {
    const r = await api('/api/catalogue-import', JSON.parse(await file.text()));
    toast(`Imported ${fmt(r.seeds)} verified seed${r.seeds === 1 ? '' : 's'} in ${fmt(r.finds)} find${r.finds === 1 ? '' : 's'}${r.rejected ? ` · ${fmt(r.rejected)} failed the check` : ''}${r.otherVersion ? ` · ${fmt(r.otherVersion)} for another game version skipped` : ''}`);
    loadCatalogue();
  } catch (error) { toast(error instanceof SyntaxError ? 'That file is not valid JSON.' : error.message, true); }
};

// ---- Layers --------------------------------------------------------------
const TERRAIN_LAYERS = [
  ['relief', 'mountain', 'Relief shading', 'Light and shadow from the shape of the land'],
  ['contours', 'contour', 'Contour lines', 'Lines of equal height'],
  ['grid', 'grid', 'Chunk grid', 'Chunks up close, regions further out'],
  ['slime', 'slime', 'Slime chunks', 'Shown once you zoom in'],
];
const MARKER_LAYERS = [
  ['spawn', 'home', 'World spawn', 'The generator’s starting region'],
  ['matches', 'check-circle', 'Search matches', 'What matched your conditions in this world'],
  ['labels', 'tag', 'Marker labels', 'Names appear when zoomed in'],
];
const toggleRow = ([name, glyphName, title, hint]) => `<label class="toggle"><span class="glyph" style="--c:var(--text-2)">${icon(glyphName)}</span><span class="toggle-text"><b>${title}</b><small>${hint}</small></span><input type="checkbox" data-layer="${name}" ${worldMap.layers[name] ? 'checked' : ''}><i class="switch"></i></label>`;
const zoomName = stop => `Z${worldMap.ZOOM_STOPS.indexOf(stop) + 1}`;
let featureStats = {};
function renderLayers() {
  $('terrain-layers').innerHTML = TERRAIN_LAYERS.map(toggleRow).join('');
  $('marker-layers').innerHTML = MARKER_LAYERS.map(toggleRow).join('');
  document.querySelectorAll('[data-basemap]').forEach(b => b.classList.toggle('active', b.dataset.basemap === worldMap.layers.basemap));
  document.querySelector('.master [data-layer]').checked = worldMap.layers.structures;
  $('feature-layers').classList.toggle('off', !worldMap.layers.structures);
  $('feature-layers').innerHTML = worldMap.features().map(f => `<div class="feature-layer" data-row="${esc(f.key)}">
    ${STRUCTURE_FAMILIES.includes(f.key) && familyVariants(f.key).length > 1 ? `<button type="button" class="layer-category" data-layer-category="${esc(f.key)}" aria-pressed="${f.on}">${glyph('structure', f.key)}<span class="toggle-text"><b>${esc(familyName(f.key))}</b><small></small></span></button><button type="button" class="subcategory-arrow" data-layer-subcategories="${esc(f.key)}" aria-label="Choose ${esc(familyName(f.key))} subcategories" title="Choose subcategories">${icon('chevron')}</button>` : `${glyph('structure', f.key)}<span class="toggle-text"><b>${esc(label(f.key))}</b><small></small></span>`}
    <select data-from="${esc(f.key)}" title="Zoom level ${esc(label(f.key))} appears at" aria-label="Zoom level ${esc(label(f.key))} appears at">${worldMap.ZOOM_STOPS.map(stop => `<option value="${stop}" ${stop === f.from ? 'selected' : ''}>${zoomName(stop)}</option>`).join('')}</select>
    <label class="switch-wrap"><input type="checkbox" data-feature="${esc(f.key)}" ${f.on ? 'checked' : ''} aria-label="Show ${esc(label(f.key))}"><i class="switch"></i></label>
  </div>`).join('');
  renderFeatureNotes();
}
// The small line under each structure layer: how many are in view, or why none are.
function renderFeatureNotes() {
  const level = worldMap.zoomLevel(), open = !!worldMap.seed();
  $('zoom-chip').textContent = open ? `Now at Z${level}` : 'Z1–Z7';
  for (const f of worldMap.features()) {
    const row = document.querySelector(`[data-row="${CSS.escape(f.key)}"]`), s = featureStats[f.key]; if (!row) continue;
    const waiting = f.on && worldMap.layers.structures && open && !(s?.shown);
    row.classList.toggle('dim', !f.on || waiting);
    row.querySelector('small').textContent = !f.on ? 'Hidden' : !open ? `From ${zoomName(f.from)}` : waiting ? `Zoom in to ${zoomName(f.from)}` : !s ? '' : s.limited ? 'Too many here, zoom in' : s.loading && !s.count ? 'Loading…' : `${fmt(s.count)} in view`;
  }
}
$('panel').addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.layer) { worldMap.setLayer(el.dataset.layer, el.checked); if (el.dataset.layer === 'structures') $('feature-layers').classList.toggle('off', !el.checked); }
  else if (el.dataset.feature) { worldMap.setFeature(el.dataset.feature, { on: el.checked, ...(el.checked && STRUCTURE_FAMILIES.includes(el.dataset.feature) ? { variants: null, placements: null, templates: null } : {}) }); renderLayers(); }
  else if (el.dataset.from) worldMap.setFeature(el.dataset.from, { from: Number(el.value) });
  else return;
  presetChanged(); renderFeatureNotes();
});
$('feature-layers').onclick = e => {
  const arrow = e.target.closest('[data-layer-subcategories]');
  if (arrow) { openSubcategories(arrow.dataset.layerSubcategories, 'layers'); return; }
  const button = e.target.closest('[data-layer-category]'); if (!button) return;
  const key = button.dataset.layerCategory, feature = worldMap.features().find(f => f.key === key);
  worldMap.setFeature(key, { on: !feature.on, ...(!feature.on ? { variants: null, placements: null, templates: null } : {}) });
  presetChanged(); renderLayers();
};
$('basemaps').onclick = e => { const b = e.target.closest('[data-basemap]'); if (!b) return; worldMap.setLayer('basemap', b.dataset.basemap); presetChanged(); renderLayers(); };
$('features-reset').onclick = () => { worldMap.applyLayers({ ...worldMap.snapshot(), features: {} }); presetChanged(); };
worldMap.on('features', stats => { featureStats = stats; renderFeatureNotes(); });
worldMap.on('layers', renderLayers);
let lastLevel = 0;
worldMap.on('view', v => {
  for (const [id, value] of [['map-x', v.x], ['map-z', v.z]]) if (document.activeElement !== $(id)) $(id).value = Math.round(value);
  if (v.level !== lastLevel) { lastLevel = v.level; renderFeatureNotes(); }
});
worldMap.on('open', () => { featureStats = {}; renderFeatureNotes(); });

// Presets: a named copy of every layer setting. Built-in ones are recipes; saved ones live in this browser.
const only = keys => Object.fromEntries(worldMap.features().map(f => [f.key, { ...worldMap.defaultFeature(f.key), on: keys.includes(f.key) }]));
const BUILTIN_PRESETS = [
  ['Recommended', () => ({})],
  ['Landmarks only', () => ({ features: only(['strongholds', 'woodland_mansions', 'ancient_cities', 'ocean_monuments', 'villages', 'trial_chambers', 'pillager_outposts']) })],
  ['Loot run', () => ({ features: only(['desert_pyramids', 'jungle_temples', 'ruined_portals', 'shipwrecks', 'ocean_ruins', 'buried_treasures', 'trail_ruins', 'trial_chambers', 'mineshafts']) })],
  ['Terrain study', () => ({ structures: false, contours: true, relief: true })],
];
const storedPresets = () => { try { return JSON.parse(localStorage.getItem('seed-scout-presets')) || []; } catch { return []; } };
let activePreset = localStorage.getItem('seed-scout-preset') || 'Recommended';
function renderPresets() {
  const saved = storedPresets(), option = name => `<option ${name === activePreset ? 'selected' : ''}>${esc(name)}</option>`;
  $('layer-preset').innerHTML = (activePreset === 'Custom' ? '<option selected>Custom</option>' : '')
    + `<optgroup label="Built in">${BUILTIN_PRESETS.map(([name]) => option(name)).join('')}</optgroup>`
    + (saved.length ? `<optgroup label="Saved">${saved.map(p => option(p.name)).join('')}</optgroup>` : '');
  $('preset-delete').hidden = !saved.some(p => p.name === activePreset);
}
function setPreset(name) { activePreset = name; localStorage.setItem('seed-scout-preset', name); renderPresets(); }
// Any manual change means the map no longer shows the named preset.
function presetChanged() { if (activePreset !== 'Custom') setPreset('Custom'); }
$('layer-preset').onchange = e => {
  const name = e.target.value, builtin = BUILTIN_PRESETS.find(p => p[0] === name), saved = storedPresets().find(p => p.name === name);
  if (!builtin && !saved) return;
  worldMap.applyLayers(builtin ? builtin[1]() : saved.layers); setPreset(name);
};
$('preset-save').onclick = () => { $('preset-form').hidden = false; $('preset-name').value = storedPresets().some(p => p.name === activePreset) ? activePreset : ''; $('preset-name').focus(); };
$('preset-cancel').onclick = () => { $('preset-form').hidden = true; };
$('preset-form').onsubmit = e => {
  e.preventDefault();
  const name = $('preset-name').value.trim();
  if (!name) return $('preset-name').focus();
  if (name === 'Custom' || BUILTIN_PRESETS.some(p => p[0] === name)) return toast('That name is taken by a built-in preset. Choose another.', true);
  localStorage.setItem('seed-scout-presets', JSON.stringify([...storedPresets().filter(p => p.name !== name), { name, layers: worldMap.snapshot() }]));
  $('preset-form').hidden = true; setPreset(name); toast(`Saved preset “${name}”`);
};
$('preset-delete').onclick = () => {
  localStorage.setItem('seed-scout-presets', JSON.stringify(storedPresets().filter(p => p.name !== activePreset)));
  toast(`Deleted preset “${activePreset}”`); setPreset('Custom');
};

const MARKER_KEY = `<h4>Markers</h4><div class="legend-list">${Object.entries(GROUPS).filter(([k]) => k !== 'other').map(([, g]) => `<span><i class="dot" style="background:${g.colour}"></i>${g.name}</span>`).join('')}<span><i class="dot star">${icon('home')}</i>World spawn</span></div><p class="hint">A white ring marks a search match. Small dots are markers hidden behind a more important one; zoom in to open them up.</p>`;
worldMap.on('legend', data => {
  const land = data.basemap === 'elevation'
    ? `<h4>Elevation</h4><div class="ramp land"></div><div class="ramp-labels"><span>Y 40</span><span>63</span><span>100</span><span>160</span><span>256</span></div><div class="ramp water"></div><div class="ramp-labels"><span>Shallow</span><span>Deep water</span></div>`
    : `<h4>Biomes in view</h4><div class="legend-list">${data.biomes.slice(0, 18).map(b => `<span><i class="swatch" style="background:${worldMap.biomeColour(b.key)}"></i>${esc(label(b.key))}<small>${b.share >= .01 ? Math.round(b.share * 100) + '%' : '<1%'}</small></span>`).join('') || '<span>Loading terrain…</span>'}</div>${data.biomes.length > 18 ? `<p class="hint">and ${data.biomes.length - 18} more</p>` : ''}`;
  $('legend').innerHTML = land + MARKER_KEY;
});
worldMap.on('close', () => { $('legend').innerHTML = '<p class="hint">Open a seed to see what is in view.</p>'; featureStats = {}; renderFeatureNotes(); });

// ---- Go to: coordinates, or the nearest feature of a kind -----------------
function toggleGoto(open = $('goto').hidden) {
  if (!worldMap.seed()) return;
  $('goto').hidden = !open; $('tool-goto').classList.toggle('active', open);
  if (open) { $('nearest-status').textContent = ''; $('map-x').focus(); $('map-x').select(); }
}
$('tool-goto').onclick = () => toggleGoto();
$('goto-close').onclick = () => toggleGoto(false);
worldMap.on('goto', () => toggleGoto(true));
worldMap.on('escape', () => toggleGoto(false));
worldMap.on('close', () => toggleGoto(false));
$('goto-form').onsubmit = e => {
  e.preventDefault();
  const x = Number($('map-x').value), z = Number($('map-z').value);
  if (Number.isFinite(x) && Number.isFinite(z)) worldMap.flyTo(x, z);
};
$('nearest-form').onsubmit = async e => {
  e.preventDefault();
  const seed = worldMap.seed(), view = worldMap.view(), [featureKind, key] = $('nearest-feature').value.split(':'), status = $('nearest-status');
  if (!seed || !key) return;
  $('nearest-go').disabled = true; status.classList.remove('error'); status.textContent = `Looking for the nearest ${label(key).toLowerCase()}…`;
  try {
    const response = await api('/api/scan', { seed, x: Math.round(view.x), z: Math.round(view.z), features: [{ kind: featureKind, key, radius: 2000 }] });
    if (worldMap.seed() !== seed) return;
    const nearest = response.features[0];
    status.textContent = nearest ? `${label(key)} ${fmt(nearest.distance)} blocks away, at X ${nearest.x}, Z ${nearest.z}.` : `No ${label(key).toLowerCase()} within 2,000 blocks of the map centre.`;
    if (nearest) worldMap.pin(nearest);
  } catch (error) { status.textContent = error.message; status.classList.add('error'); }
  finally { $('nearest-go').disabled = false; }
};
$('chip-copy').onclick = () => copyText(worldMap.seed(), 'Seed copied');

// ---- Shell ---------------------------------------------------------------
document.querySelectorAll('[data-icon]').forEach(el => { el.outerHTML = icon(el.dataset.icon, el.className); });
document.querySelectorAll('[data-open]').forEach(el => el.onclick = () => openPanel(el.dataset.open));
$('search-status').onclick = () => openPanel('results', true);
$('tool-layers').onclick = () => openPanel('layers');
$('quit').onclick = async () => {
  if (!confirm('Close Seed Scout? This stops the local engine and any running search.')) return;
  try { await api('/api/shutdown', {}); } catch { }
  clearInterval(timer);
  document.body.innerHTML = '<div class="closed"><h1>Seed Scout is closed</h1><p>You can close this tab. Launch Seed Scout again to pick up where you left off.</p></div>';
};
function setStatus(mode, text) { const pill = $('search-status'); pill.dataset.state = mode; pill.lastElementChild.textContent = text; }
async function poll() {
  let fresh;
  try { fresh = await (await fetch('/api/status')).json(); }
  catch { setStatus('error', 'Disconnected'); return notice('Cannot reach the local app. Relaunch Seed Scout to reconnect.', true); }
  if (fresh.catalog && !catalog) {
    catalog = fresh.catalog;
    for (const [family, keys] of Object.entries(catalog.structureVariants || {})) for (const key of keys) {
      STRUCTURES[key] = [`${label(family)} (${variantName(family, catalog.variantDetails[key])})`, STRUCTURES[family][1], STRUCTURES[family][2]];
    }
    for (const family of PORTAL_FAMILIES) for (const p of PORTAL_PLACEMENTS) {
      STRUCTURES[`${family}_${p}`] ||= [`${label(family)} (${label(p).toLowerCase()})`, 'portal', STRUCTURES[family][2]];
    }
    for (const [id, f] of chosen) if (!(f.kind === 'structure' ? catalog.sets : catalog.biomes).includes(f.key)) chosen.delete(id);
    for (const family of STRUCTURE_FAMILIES) mergeFamilyConditions(family);
    if (!chosen.size) chosen.set('structure:villages', condition('structure', 'villages'));
    // Offer as many search workers as the machine has logical cores, keeping the saved choice.
    const cores = catalog.cores || 8, workers = $('threads').value || '4';
    $('threads').innerHTML = [1, 2, 4, 6, 8, 12, 16, 20, 24, 28, 32, 48, 64].filter(n => n <= Math.max(8, cores)).map(n => `<option>${n}</option>`).join('');
    $('threads').value = [...$('threads').options].some(o => o.value === workers) ? workers : '4';
    $('cores-hint').textContent = `${cores} cores`;
    $('mapWorkers').innerHTML = WORKER_STEPS.filter(n => n <= cores).map(n => `<option>${n}</option>`).join('');
    $('mapWorkers').value = String(nearestStep(catalog.mapWorkers || 2, cores));
    showUsage();
    if (!$('version').options.length) loadVersions();
    $('settings-minecraft').textContent = `Using ${versionName(catalog.version)}. Change the version with the list at the top right.`;
    $('nearest-feature').innerHTML = [['structure', catalog.sets], ['biome', catalog.biomes]].map(([k, keys]) => `<optgroup label="${k === 'structure' ? 'Structures' : 'Biomes'}">${[...keys].sort((a, b) => label(a).localeCompare(label(b))).map(key => `<option value="${k}:${esc(key)}">${esc(label(key))}</option>`).join('')}</optgroup>`).join('');
    // The structure layers are now known, so the map can start filling them in.
    worldMap.refresh(); renderLayers();
    renderFeatures(); renderChosen();
    notice('Ready. Choose features, then start searching.');
    // The empty map doubles as the first-run screen: what was found, and two ways to see something at once.
    $('empty-title').textContent = 'A good world is out there.';
    $('empty-text').textContent = 'Choose features on the left and start a search, open any seed from the bar above, or start with one of these.';
    $('empty-actions').hidden = false;
    $('empty-hint').textContent = `Using ${versionName(catalog.version)} from your Minecraft install.${navigator.userAgent.includes('Electron') ? ' To bring saved seeds from another copy, use File → Import saved seeds and catalogue.' : ''}`;
    renderSpawnRules(); restoreLastView(); queueEstimate();
  }
  if (state.running && !fresh.running && !fresh.error) {
    // A search that ran for a while, or finished while the window was out of sight, is announced by the system too.
    if ((document.hidden || (fresh.seconds || 0) > 30) && window.Notification?.permission === 'granted') new Notification('Seed Scout search finished', { body: `${fmt(fresh.matches || 0)} match${fresh.matches === 1 ? '' : 'es'} from ${fmt(fresh.tested || 0)} checked seeds.` });
    notice(`Search finished: ${fmt(fresh.matches || 0)} matches from ${fmt(fresh.tested || 0)} checked seeds.`);
    toast(fresh.catalogued ? `Search finished · ${fmt(fresh.matches || 0)} matches · rare combination added to your catalogue` : `Search finished · ${fmt(fresh.matches || 0)} matches`);
    loadCatalogue();
  }
  if (state.world?.running && fresh.world && !fresh.world.running) {
    const found = fresh.world.places?.length || 0;
    toast(`Search inside the seed ${fresh.world.complete ? 'finished' : 'stopped'} · ${fmt(found)} place${found === 1 ? '' : 's'}`);
    if ((document.hidden || (fresh.world.seconds || 0) > 30) && window.Notification?.permission === 'granted') new Notification('Seed Scout: search inside the seed', { body: `${fmt(found)} place${found === 1 ? '' : 's'} found, ${fmt(fresh.world.covered || 0)} blocks covered.` });
  }
  state = fresh;
  const tested = state.tested || 0, limit = Number(state.request?.limit) || 0;
  $('tested').textContent = fmt(tested); $('matches').textContent = fmt(state.matches || 0);
  $('rate').textContent = state.seconds > 0 ? fmt((tested / state.seconds).toFixed(tested / state.seconds < 100 ? 1 : 0)) : '—';
  if (!state.ready) setStatus('starting', 'Starting engine');
  else if (state.error) setStatus('error', 'Search error');
  else if (state.running) setStatus('running', state.phase === 'catalogue' ? 'Checking your catalogue' : `Searching · ${fmt(tested)} checked`);
  else setStatus('ready', tested ? `${fmt(state.matches || 0)} match${state.matches === 1 ? '' : 'es'} found` : 'Ready');
  const known = state.catalogueMatches ? ` ${fmt(state.catalogueMatches)} came straight from your catalogue.` : '';
  $('results-summary').textContent = state.running ? (state.phase === 'catalogue' ? `Checking ${fmt(state.catalogueChecked || 0)} catalogued seeds first.` : `Searching from seed ${state.request?.seed}. The best matches rise to the top.${known}`)
    : tested || state.matches ? `${fmt(state.matches || 0)} matches from ${fmt(tested)} new seeds, closest first.${known}` : 'Matching seeds appear here as they’re found.';
  $('progress').hidden = !state.running; $('progress').firstElementChild.style.width = `${limit ? Math.min(100, tested / limit * 100) : 0}%`;
  const canResume = !state.running && !!state.nextSeed;
  $('stop').hidden = $('stop-results').hidden = !state.running; $('stop').disabled = $('stop-results').disabled = false;
  $('resume').hidden = $('resume-results').hidden = !canResume; $('run-actions').hidden = !state.running && !canResume;
  syncButtons();
  if (state.error) notice(state.error, true);
  renderResults(); renderWorld();
}
syncAnchor(); renderLayers(); renderPresets(); renderConditionPresets(); renderSpawnRules(); syncSearchMode(); renderChosen(); openPanel('find', true); loadSaved().then(loadCatalogue); poll();
const timer = setInterval(poll, 1000);
