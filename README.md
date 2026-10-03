# Seed Scout

A local seed finder for **Minecraft Java 26.4 Snapshot 2**.

## Use it

1. Double-click **Launch Seed Scout.cmd**. It opens http://127.0.0.1:8877.
2. Select structures and/or biomes. Set each distance in **blocks**. Choose spawn region or custom X/Z.
3. Click **Start searching**, select a result, and **Copy seed** into Minecraft's Create World screen.

Every selected feature is required. Presets are convenient starting points.
**Search controls** lets you set 1–8 workers, a starting seed, the seed budget, result limit,
and a maximum distance between feature matches. Blank starting seed chooses a random signed 64-bit seed.
Stop waits for active checks; Resume starts at the earliest unfinished seed, potentially repeating
some completed checks rather than skipping any. Results persist in runtime/last-search.json.
The **Check** field checks an existing numeric seed against your current selection.
Export saves JSON including feature coordinates to runtime/exported-results.json and offers a browser download. Click a seed card to generate its terrain map. Drag or use arrow keys to pan; scroll or +/- to zoom. Spawn recentres the map. Expand opens a larger map. Move over the map for coordinates, biome and ground height. New areas generate as you pan; cached tiles are reused. Only selected search matches are shown as numbered markers; the map does not scan every structure in newly viewed areas.
Close app stops the local backend; closing only the browser leaves it available for another visit.

## Accuracy

- Uses your **installed snapshot's own vanilla registry, biome, noise, placement and structure-start code**.
  The snapshot supplies the feature list, including its new biomes and structures.
- Structure results confirm valid generation starts and pieces. They do not generate all blocks or
  validate post-placement terrain/loot. Coordinates are the structure's locate position;
  Y is its bounding-box minimum, not necessarily an entrance or walkable height.
- Spawn is the generator's initial spawn region. Final player spawn can shift after terrain checks.
  Distances are horizontal distances from that region, not a guarantee from the final player position.
- The default terrain-aware biome search samples every 32 blocks at the snapshot's actual base
  surface height, with Minecraft's seeded block-biome boundary resolver. Cave targets use Y=-32.
  Tiny patches or caves at other heights can still be missed. The optional fast mode prefilters at
  Y=64 before confirming surface height, and may miss more mountain biomes.
- Terrain tiles use the snapshot's base noise columns for ground elevation, surface water,
  surface biome and relief shading. Tiles refine when zoomed in (minimum 4 blocks/sample).
  This is a sampled base-terrain preview: surface building, trees, structures, decorations,
  and later changes are not generated. It is not a block-exact image of a completed world.
- Cluster distance checks the nearest matches found. Another valid grouping can be missed.
- Default vanilla Overworld only. Custom world-generation datapacks, large biomes, amplified worlds,
  loot contents, specific building layouts and terrain shapes are not search criteria.
- This is an efficient position search, not a full block-by-block world simulation or an exhaustive mathematical
  search of all 2^64 seeds. Wide radii and expensive features reduce throughput.

## Implementation and requirements

Python's standard library serves a local-only browser UI. A persistent Java process runs parallel
search workers, checking candidate structure placements before building valid structure starts.
Nothing is installed into Minecraft, and existing saves are not opened or modified.
Temporary template storage, classes and logs stay inside this app's ignored runtime directory.

Configured for this machine's Python, ../.tools/jdk-25.0.4.1+1, and
%APPDATA%/.minecraft/versions/26.4-snapshot-2. The installed launcher libraries must be present.
Minecraft binaries are read locally and are **not redistributed**. Modify build.py for other paths.
Opening the launcher a second time reopens the existing app instead of starting duplicate workers.

Run the integration checks while the app is open:

```powershell
python tests/integration.py
```

Checks cover deterministic snapshot structures, 64-bit seeds, custom origins, biome sampling,
parallel budgets, stop/resume and invalid settings. They do not replace verification in a newly
created Minecraft world. A measured 20-seed village search on this PC ran around 25 seeds/second;
that small warm-engine sample is illustrative, not a performance guarantee.

The fast-map principle is to calculate selected biome/structure positions rather than generate
and render every block. Cubiomes demonstrates this openly: https://github.com/Cubitect/cubiomes.
Seed Scout instead uses the installed snapshot directly for version-specific behavior.

## Research behind the map

Chunkbase explains that underlying biome coastlines can differ from actual terrain, and its terrain
option adjusts those colours. Its own known limitations include world spawn and missing structures:
https://www.chunkbase.com/apps/seed-map (reviewed 2026-10-03; page updated for MC 26.3).
Cubiomes exposes fast biome/structure calculations and warns that some structures also need
surface-height viability checks: https://github.com/Cubitect/cubiomes.
We use the locally installed 26.4 snapshot implementation rather than assume a 26.3 map library
matches this snapshot. Native terrain columns and seeded biome boundary resolution improve
surface accuracy without generating or touching player worlds.
