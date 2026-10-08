// Habitat searches offer the real cave biome, only when the selected game's catalogue contains it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('web/app.js', 'utf8');
const scope = {
  catalog: { biomes: ['ice_caves', 'plains'] }, chosen: new Map(),
  label: key => key.replaceAll('_', ' '), esc: s => s, glyph: () => '', icon: () => '',
  REALMS: {}, STRUCTURE_FAMILIES: [],
};
vm.runInNewContext(source.slice(source.indexOf('const BIOME_HINTS ='), source.indexOf('function renderFeatures()')) + '\nthis.tiles = featureTiles;', scope);
for (const term of ['ice caves', 'ice crystals', 'icicles', 'frostbite']) {
  const html = scope.tiles('biome', term);
  assert.match(html, /data-key="ice_caves"/);
  assert.match(html, /Underground/);
  assert.doesNotMatch(html, /data-key="plains"/);
}
scope.chosen.set('biome:ice_caves', {});
assert.match(scope.tiles('biome', 'ice'), /checked/);
scope.catalog.biomes = ['plains'];
assert.equal(scope.tiles('biome', 'frostbite'), '');
vm.runInNewContext(fs.readFileSync('web/terrain.js', 'utf8') + '\nthis.renderer = terrain;', scope);
assert.equal(scope.renderer.colour('ice_caves'), '#98dce8');
console.log('Snapshot biome chooser and colour checks passed');
