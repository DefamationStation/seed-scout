// Exercise the real rasteriser and drawing transform with a fixed world-space landmark.
// No server or canvas dependency is needed: retain the ImageData written to the canvas.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const scope = {
  DOMMatrix: class { constructor(values) { [this.a, this.b, this.c, this.d, this.e, this.f] = values; } },
  document: { createElement() {
    const image = {};
    image.getContext = () => ({
      createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: pixels => { image.pixels = pixels.data; },
      drawImage() {},
    });
    return image;
  } },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/terrain.js'), 'utf8') + '\nthis.renderer = terrain;', scope);
const terrain = scope.renderer;
let checks = 0;
for (const [wx, wz] of [[0, 0], [64, 96], [-64, -96], [496, 496], [-512, -512]]) {
  for (const step of [1, 2, 4, 8, 16]) {
    const span = step * 32, x = Math.floor(wx / span) * span, z = Math.floor(wz / span) * span;
    const index = (wz - z) / step * 32 + (wx - x) / step;
    const tile = { x, z, step, palette: ['plains', 'forest'], biomes: Array(1024).fill(0), elevation: Array(1024).fill(80), water: Array(1024).fill(false) };
    tile.biomes[index] = 1;
    for (const relief of [false, true]) for (const maxSize of [32, 64, 96, 256]) {
      const image = terrain.raster(tile, { basemap: 'biome', relief }, () => null, maxSize);
      let count = 0, sumX = 0, sumZ = 0;
      for (let p = 0; p < image.pixels.length; p += 4) {
        if (image.pixels[p] !== 77 || image.pixels[p + 1] !== 140 || image.pixels[p + 2] !== 69) continue;
        const pixel = p / 4;
        sumX += pixel % image.width + .5; sumZ += Math.floor(pixel / image.width) + .5; count++;
      }
      assert.ok(count > 0, 'The raster must retain the landmark');
      for (const bpp of [.0625, .7, 1.3, 5, 64]) {
        const extent = terrain.placement(tile), centre = { x: 13.25, z: -7.75 }, width = 1037, height = 643;
        const left = width / 2 + (extent.x - centre.x) / bpp, top = height / 2 + (extent.z - centre.z) / bpp;
        let drawn;
        const ctx = {
          createPattern: () => ({ setTransform(matrix) { this.matrix = matrix; } }),
          fillRect() { drawn = this.fillStyle.matrix; },
        };
        // High DPI ensures even sub-pixel cached tiles in the farthest view have a device pixel.
        terrain.drawRaster(ctx, image, tile, left, top, extent.span / bpp, 2);
        const actualX = (drawn.e + (sumX / count + 1) * drawn.a - width / 2) * bpp + centre.x;
        const actualZ = (drawn.f + (sumZ / count + 1) * drawn.d - height / 2) * bpp + centre.z;
        assert.ok(Math.abs(actualX - (wx + .5)) < 1e-8, `X drift at step ${step}: ${actualX} versus ${wx + .5}`);
        assert.ok(Math.abs(actualZ - (wz + .5)) < 1e-8, `Z drift at step ${step}: ${actualZ} versus ${wz + .5}`);
        checks++;
      }
    }
    const at = terrain.cell(wx + .5, wz + .5, step);
    assert.equal(at.x, x); assert.equal(at.z, z); assert.equal(at.index, index);
    const west = terrain.cell(wx + .5 - step / 2 - .001, wz + .5, step);
    const east = terrain.cell(wx + .5 + step / 2 + .001, wz + .5, step);
    assert.equal(west.x + (west.index % 32) * step, wx - step);
    assert.equal(east.x + (east.index % 32) * step, wx + step);
    const extent = terrain.placement(tile), next = terrain.placement({ ...tile, x: x + span });
    assert.equal(extent.x + extent.span, next.x, 'Neighbours must meet at the same world coordinate');
  }
}
console.log(`${checks} landmark alignment checks passed across all five terrain resolutions, including negative coordinates and fractional zooms.`);
