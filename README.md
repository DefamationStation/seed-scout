# Seed Scout

A local seed finder for **Minecraft Java 26.4 Snapshot 2**.

## Use it

1. Double-click **Launch Seed Scout.cmd**. It opens http://127.0.0.1:8877.
2. In **Find**, tick structures and/or biomes, then set each one under *Conditions*.
   Choose world spawn or custom X/Z as the search origin.
3. Click **Start searching**. **Results** lists matches closest-first; click one to open it on the map,
   and **Copy** its seed into Minecraft's Create World screen.

The window is a map workspace: a rail on the left switches between **Find**, **Results**, **Saved**,
**Layers** and **About**; clicking the active rail button collapses the panel for a full-width map.
The bar at the top opens any numeric seed directly, and the status pill beside it shows search progress.

Every condition must hold. Each one is either **Near** or **Avoid**:
- *Near*: at least N of the feature (structures only, 1–10) between a minimum and a maximum distance
  from the search origin, in blocks. The result lists the N nearest matches.
- *Avoid*: none of the feature within the distance. Structure exclusions use the generation-point
  check; biome exclusions mean no sample on the 32-block grid matched in the chosen biome mode.

Distances run from the search origin unless you pick another condition in the *from* selector, which
appears once a structure you want nearby is in the list. "A trial chamber within 200 blocks of the
village" is then tested around every village in range, nearest first, and the first village that
satisfies all the conditions tied to it is the one reported; with "2 or more" villages, each counted
village must satisfy them. A condition on the same type ("another village within 400 of the village")
does not count the village itself. Only a structure measured from the origin can be measured from, so
conditions do not chain. The map joins each such match to the structure it was measured from.

Presets are convenient starting points.
**Search controls** lets you set the number of workers (up to the machine's logical core count), a starting seed, the seed budget, result limit,
and a maximum distance between feature matches. A search tries seeds in order, counting up from the
starting seed. Leave the starting seed blank and every search begins at a new random signed 64-bit
seed; the field is not remembered between sessions, and a typed value is only used while it stays there.
Stop waits for active checks; Resume starts at the earliest unfinished seed, potentially repeating
some completed checks rather than skipping any. Results persist in runtime/last-search.json.
**Check a seed you already have** tests an existing numeric seed against your current conditions.
Export saves JSON including feature coordinates to runtime/exported-results.json and offers a browser download.

Map controls: drag or use arrow keys to pan; scroll, pinch or +/- to zoom; **H** returns to spawn,
**M** measures a distance between two points and **G** opens *Go to*. The status bar shows the coordinates,
chunk, biome and ground height under the pointer, and the zoom level (Z1 furthest out to Z7 closest).
Sample spacing always follows the zoom (about 2–4 screen pixels per sample), so a view needs the same
few hundred tiles however far out it is. Up to 8 blocks per pixel (Z4–Z7) the map shows **base terrain**:
the snapshot's full terrain columns for heights, water and biomes, 1–16 blocks per sample. Farther out
(Z1–Z3) it shows a **biome overview**, 32–128 blocks per sample, which skips the terrain columns and
loads about 15 times faster; the status bar says which one is on screen. Terrain views show a few
overview tiles as a preview while they load, and cached tiles remain visible underneath a loading view.
Within base terrain, zoom only changes the spacing of samples: values at the same sampled coordinate
agree at every scale. Click a location for its individual terrain check.
Raster cells, relief and contours stay centred on those same block centres at every resolution,
so replacing previews with finer tiles does not introduce a uniform northwest shift.
The closest views sample every individual block. Zoom reaches 16 pixels per block, with a block grid
at 8 pixels per block or closer; selecting a location highlights one block rather than its entire chunk.
Tiles are fetched several per request, compressed and cached by the browser across reloads, with bounded
memory caches in the map and backend. Panning and zooming briefly defer new requests until the view settles.
The power button stops the local backend; closing only the browser leaves it available for another visit.

## Desktop app

`desktop/` wraps the same local app in a window (Electron) and installs like any Windows program. It brings its
own Python and Java, so the only requirement is Minecraft installed through the launcher (the engine is written
for 26.4-snapshot-2). On first start it looks in `%APPDATA%/.minecraft`; if nothing is installed there it asks for the Minecraft folder
(*File → Minecraft folder…* changes it later). Saved seeds, the catalogue and the compiled engine are kept in
`%APPDATA%/Seed Scout/data`, which updates leave alone; `desktop.log` beside it records each start.

Every push to `main` that touches the app runs `.github/workflows/release.yml`: it raises the patch version in
`desktop/package.json`, builds the installer and publishes it as a GitHub Release, then writes the update feed
(`latest.yml` on the `update-feed` branch) with the installer's address and checksum. An installed copy reads
that feed at start and every four hours and asks whether to update. Yes downloads it and offers to restart;
No is remembered, and nothing is offered again until you update from *Help → Check for updates…*. Both are read without signing in,
so updates only work while the repository is public.

The desktop shell has a self-test that answers its own dialogs and records what was shown:
`"Seed Scout.exe" --selftest=full` (needs Minecraft; engine, a tile, About, What's new, the Settings links,
import and the whole update conversation), `--selftest=nominecraft` and `--selftest=smoke`. Each writes
`selftest.json` to its user data folder and exits with 0 when every check passed. The release workflow runs the
smoke scenario on the packaged app and does not publish a build that fails it.

```powershell
cd desktop
npm install
npm start                                  # run from this checkout, using this machine's Python and JDK
./vendor.ps1 -Jdk <path to a JDK 25>       # fetch embeddable Python and build the trimmed Java runtime
npm run dist                               # build the installer into desktop/dist
```

## Searching inside one seed

*Find → Inside one seed* looks through a single world instead of through many seeds. Enter the seed, choose
what to look for, and it reports every place where the conditions hold, nearest to the origin first (the world
spawn, or coordinates you give).

- **What a place is.** One condition is the anchor: the rarest structure you asked for (strongholds first, then
  the widest-spaced structure), or the first biome when there is no structure. Every anchor found is a candidate
  place, and your other conditions are measured from it with their own distances, exactly as a seed search
  measures them from the spawn. Avoid conditions and conditions measured from another one work the same way.
  With a count of 1 the anchor's own distance is not used.
- **Groups of one structure.** Give a structure a count above 1 and it becomes the anchor as a group: that many
  of it within its distance of one of them ("3 ancient cities, 0 to 2,000 blocks"). Each group is reported once,
  from the member nearest the origin, with every member listed. *Search out to* limits where that member is;
  the others may lie just beyond it. Other conditions are measured from that member.
- **How far.** *Search out to* goes from 10,000 blocks to the whole world (29,999,984 blocks each way). The world
  is cut into 4,096-block regions taken in a square spiral from the origin, on as many workers as Settings allows.
- **How long.** It depends on the anchor: every potential position of it is tested with the game's own
  generation check, about 0.4 ms each. On this PC with 16 workers, a block of 2,209 regions took 0.5 s for a
  woodland mansion group, 5 s for a village group and 8–11 s for shipwreck or ancient city groups. That puts
  1,000,000 blocks at seconds to minutes, and the world border at half a day for the rarest anchors and one to
  two weeks for common ones. Asking for every village with no other condition
  is far slower (about 5 regions a second), because every reported structure is fully built.
- **Stopping and continuing.** It stops after the number of places you set (up to 500 at a time) or when you
  press Stop; *Keep searching* carries on from the ring it reached. Places and progress are saved in
  `runtime/last-world-search.json` and are still there after a restart.
- **Biomes as the anchor** are sampled every 64 blocks on the biome source and confirmed on real terrain; one
  place is reported per region, the patch nearest the origin.
- **Opening a place** shows the seed on the map at that spot with its features marked.

Before any costly check, a place is dropped when another structure it needs has no potential position at the
right distance; that is placement arithmetic and cannot lose a match. A coarse biome sample of each region was
tried as a faster way to skip regions and was not kept: it lost 6–13% of the places in testing.

A seed search and a search inside a seed cannot run at the same time.

## The Nether and the End

Five structures of the other dimensions can be search conditions, under their own headings in the feature list:
**Nether fortress**, **Bastion remnant**, **Nether fossil**, **Ruined portal (Nether)** and **End city**. Each is
checked with that dimension's own generator from your install, the same way Overworld structures are.

- **Nether distances are in Nether blocks**, measured from where a portal at the search origin leads: the
  origin's X and Z divided by 8. "Fortress within 100" is a fortress within 100 Nether blocks of your first portal.
- **End distances start at the centre of the End** (0, 0), where every End portal arrives. End cities begin about
  1,000 blocks out.
- A Nether structure can be measured from an Overworld one and the other way round, through the same portal
  rule. An End structure can only be measured from another End structure.
- **Bastion remnants** can be narrowed by kind (housing, hoglin stables, treasure, bridge) and **End cities** by
  whether they have a ship. Both are read from the built structure.
- Results give each match's coordinates in its own dimension. A Nether match is drawn on the map where its portal
  comes out in the Overworld; its card shows the Nether coordinates and a teleport command that starts with
  `/execute in minecraft:the_nether run`. An End match is not on the map: clicking its chip copies the teleport
  command for it.
- The teleport spot in these dimensions is an estimate, the floor of the piece the structure grows from.
- Not yet: Nether and End biomes, maps of those dimensions, map layers for their structures, and using them when
  searching inside one seed.

## Conditions on the spawn

Under *Search around* in Find:

- **Spawn biome:** require the world spawn to be in one of a list of biomes, or keep it out of them. The biome
  is read on the real terrain column at the middle of the spawn chunk, which is within 12 blocks of the reported
  spawn point on land.
- **Slime chunks:** require at least N slime chunks in the square of chunks reaching R chunks (1–8) from the
  search origin, with the game's own slime-chunk formula.
- **Either / or:** a condition you want nearby can take up to four alternatives ("+ or…" on its row): another
  structure or biome at the same distances. The condition holds when it or any alternative does; the first one
  that holds, in the order listed, is the one reported. Alternatives are not available on conditions you avoid,
  on ones measured from another condition, or on ones another condition is measured from.

A search may consist of spawn conditions alone. These are tested first, since they cost the least.

## Minecraft version

The version at the top of the app lists the vanilla versions installed in the Minecraft folder. Picking another
one compiles the engine against it and restarts the engine on it; the choice is kept in `settings.json`. The
engine calls the game's world-generation classes directly, so a version where those differ does not compile and
is refused with the first error, leaving the current version running. Saved rare finds are kept per version.

## Saved seeds

The bookmark beside the seed number on the map, or on a found world, saves that seed. **Saved** lists
them with a free-text note each (saved as you type), the matches the search found, and the map position
at the time. **Open** brings the seed back with those matches and that position; **Save current view**
replaces the stored position. Removing a seed takes two clicks because it also removes the note.
Saved seeds are stored in `saved-seeds.json` next to `app.py`, so they are independent of the browser
and of the saved search results, and are not affected by starting a new search.

## Rare finds

When a search needs many seeds per match, its conditions and matching seeds are kept automatically under
**Saved → Rare finds**. Rarity is seeds checked per match ("about 1 in 40,000"), which does not depend
on the machine or the number of workers; the threshold is 1 in 100,000 by default and can be changed
there. A search can only show rarity up to its seed budget, which is why the default budget is
1,000,000 seeds (the maximum is 10,000,000). Later runs of the same conditions add their seeds and counts to the same entry, and a run
repeated from the same starting seed is not counted twice. With fewer than five matches the figure is
marked as a rough estimate.

Every new search first re-checks the catalogued seeds against its own conditions, on the search workers,
and reports those that match as "from your catalogue" before trying any new seed. The same search again
therefore returns at once, and a looser or related one often does. Switch **Check these seeds first** off
to search only new seeds. *Use conditions* loads an entry's conditions back into Find.

**Export** downloads the catalogue as `seed-scout-catalogue.json`; **Import** reads such a file. On
import every seed is re-checked by this engine against the entry's conditions, so a seed that does not
match is dropped and nothing in the file is taken on trust, except the exporter's count of how many seeds
were searched (shown as "includes imported counts"). Entries for another game version are skipped.
The catalogue is stored in `catalogue.db` (SQLite) next to `app.py`.

## Accuracy

- Uses your **installed snapshot's own vanilla registry, biome, noise, placement and structure-start code**.
  The snapshot supplies the feature list, including its new biomes and structures.
- Structure results confirm valid generation starts and pieces. A search first tests each candidate with
  the snapshot's generation-point check (the one the game uses for `/locate`), then builds the start
  for seeds where every feature passed, so reported structures are confirmed the same way as before.
  They do not generate all blocks or
  validate post-placement terrain/loot. Coordinates are the structure's locate position;
  Y is its bounding-box minimum, not necessarily an entrance or walkable height.
- Spawn is the world spawn point the game stores when it creates the world: from the spawn chunk it walks a
  spiral of 11 x 11 chunks and takes the first block with dry ground, which on land is the corner of the spawn
  chunk. It is worked out from base terrain for the seeds that are reported (checked against a saved world's
  level.dat). Each player then appears on a random block within 10 blocks of it (the respawn radius game rule),
  which no tool can predict. Search distances are measured from the middle of the spawn chunk.
  Distances are horizontal distances from that region, not a guarantee from the final player position.
- Biome searches look at each sample above the surface first (one lookup on the biome source) and only estimate
  the terrain where that gives the wanted biome. The matches are the same; searches for a biome that is mostly
  absent run two to five times faster.
- Biome searches sample every 32 blocks. Every reported point is confirmed at the snapshot's actual
  base surface height with Minecraft's seeded block-biome boundary resolver. Cave targets use Y=-32.
  Tiny patches or caves at other heights can still be missed. The three modes differ in which samples
  reach that confirmation:
  - *Terrain-aware* (default) keeps samples whose biome matches at the noise router's cheap surface-level
    estimate. In test searches for cherry grove and mushroom fields it matched the same seeds as
    exhaustive; for cherry grove, about 8% of matching seeds reported a point further away than the
    nearest one. A biome whose only samples are skipped by the estimate would be missed.
  - *Exhaustive* computes the terrain column at every sample. It is the reference and 3–5 times slower.
  - *Fast* keeps samples whose biome matches at Y=64, and may miss more mountain biomes.
- Structure layers on the map use the generation-point check only. It agreed with a full build in
  every one of 5,300 test attempts, and against the full-build area scan on 759 of 759 structures across
  three seeds. Clicking a marker runs the full build for that structure. Ocean monuments are
  prefiltered on 27 of the 3,375 biome cells the game requires before the game's own check runs; the
  result was identical for 1,888 of 1,888 monuments in testing.
- Base terrain views (8 blocks per pixel or closer) use the snapshot's base noise columns for ground
  elevation, surface water and surface biome. Values at shared coordinates match across those zooms.
  Very small features between samples can be missed until you zoom in.
  Relief shading and contour lines are computed in the browser from those elevations.
  At 1–2 blocks per sample a tile's columns come from one shared noise chunk and are identical to the
  game's `getBaseColumn`. At 4–16 blocks per sample each column is computed only from the router's
  surface estimate up to 128 blocks above it, without aquifers where the ground is clear of them. Against
  `getBaseColumn` on 2.46 million samples, 8 differed (about 3 per million): floating terrain more than
  128 blocks above the estimate, and a few dry or dammed spots just below sea level. Clicking a location
  always runs the full column.
- The biome overview (wider views, and the preview under loading terrain) uses the snapshot's biome
  source directly plus the noise router's surface estimate. Water is drawn only where the biome is an
  ocean or river, never from the estimated height, so it cannot invent lakes; lakes, swamp water and
  flooded coast inside land biomes appear as land until you zoom in. Against full terrain columns, 96%
  of samples had the same biome (the rest sit on biome borders) and 92% the same water flag. Heights
  are estimates in 8-block steps (within about 14 blocks for 90% of land samples): they drive relief
  shading only, the status bar shows no Y for them, and contour lines are not drawn.
  This is a sampled base-terrain preview: surface building, trees, structures, decorations,
  and later changes are not generated. It is not a block-exact image of a completed world.
- Cluster distance checks the nearest matches found. Another valid grouping can be missed.
- Default vanilla Overworld only. Custom world-generation datapacks, large biomes, amplified worlds,
  loot contents, specific building layouts and terrain shapes are not search criteria.
- This is an efficient position search, not a full block-by-block world simulation or an exhaustive mathematical
  search of all 2^64 seeds. Wide radii and expensive features reduce throughput.

## Implementation and requirements

Narrow searches near spawn now reject impossible seeds before completing all of
the spawn-noise sampling. For **woodland mansion within 100 blocks**, a same-seed
comparison on this PC improved from **2,623 to 16,541 seeds/second on four
workers**, returning the same matches. Longer runs reached about 50,500 on 16
workers and 67,300 on 28. The speedup preserves the snapshot's spawn selection
and structure confirmation; it is most useful for narrow nearby-structure
conditions. See [the measurements, algorithm and validation](SEARCH-PERFORMANCE.md).
Existing worker preferences are retained; change them under **Search controls**.

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
parallel budgets, stop/resume, structure map tiles, marker confirmation, count, distance-range,
exclusion and relative conditions, saved seeds, the rare-find catalogue with export and import, and
invalid settings. Running them replaces the saved search results; the saved-seed and catalogue tests add
and remove their own entries and leave yours alone. They do not replace verification in a newly
created Minecraft world. Measured on this PC (32 logical cores, warm engine): village + mushroom fields within 1,000 blocks ran
at about 74 seeds/second on 8 workers and 164 on 28; a single-feature village search, where most seeds
match and every match is fully built, ran at about 63 on 8. These samples are illustrative, not a
performance guarantee. Map tiles are generated by up to 16 workers (half the cores), so a search
running at the same time slows down a little while the map is loading.

The non-destructive map checks and optional view benchmark can run without replacing search results:

```powershell
python tests/map_performance.py --benchmark
node tests/terrain_alignment.js
```

On this PC, for a 1,856 × 1,000-pixel map, cold:

| Scale bar | Sampling | Tiles | Time | Download |
|---|---|---|---|---|
| 5,000 blocks (fully zoomed out) | overview, 128 blocks | 510 | 1.7 s | 1.2 MB |
| 500 blocks | terrain, 16 blocks | 209 | 2.3 s | 386 KB |
| 200 blocks | terrain, 4 blocks | 510 | 5.8 s | 637 KB |
| 100 blocks | terrain, 2 blocks | 493 | 2.2 s | 472 KB |
| 50 blocks | terrain, 1 block | 480 | 1.4 s | 342 KB |

Before the tile work the 500-block view took 6.1 s, a terrain tile cost about 25 ms at every sampling
(13 s for 500 tiles), and the fully zoomed-out view asked for 29,358 terrain tiles. The overview preview
appears under a terrain view within a few tenths of a second.
Timings depend on the seed, view, machine and running searches, and repeated benchmarks may use
cached tiles. An earlier estimated-height overview was removed because it created false lakes; the
current one takes water from the biome instead.

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

## The map and its layers

Click a found world, or type any numeric seed in the top bar and press **Open map**, to explore it
independently of the seed-search conditions. Everything drawn on the map is a layer in **Layers**.

**Structures.** Each supported structure option is its own layer, and its markers appear
automatically for whatever is in view; there is nothing to scan. Layers are ordered by importance and
each has a zoom level it appears at: strongholds and woodland mansions from Z1; ancient cities, ocean
monuments, villages and outposts from Z3; temples, huts, igloos, trail ruins and camps from Z4;
trial chambers, ruined portals, shipwrecks, ocean ruins and buried treasure from Z5; mineshafts from Z6. The
levels follow measured densities, so a layer's markers start out roughly 70 px or more apart. So
only landmarks show when zoomed out and more fills in as you zoom in. Every layer has its own switch
and its own zoom-level selector, a master switch hides them all, and *Reset* restores the defaults.
Click **Villages**, **Mineshafts**, **Ocean ruins**, **Shipwrecks**, **Abandoned camps**, or **Ruined portals**
in Find or Layers to toggle the entire family; enabling a category selects all variants by default.
Click the sliders button beside it to narrow the family. The chooser offers all the Overworld variants from the installed
snapshot: five village types, normal/badlands mineshafts, cold/warm ruins, regular/beached shipwrecks,
18 camp variants, and six portal biome variants. Each group of choices has an **Any** button; lighting some of its
choices narrows the group to those, as alternatives, and a structure must satisfy every narrowed group. In Find,
picking anything adds the family to the search. Layers filters the family's markers without
duplicating them, and saves those filters with the layer settings and presets.
The shipwreck chooser also offers all 20 shipwreck templates from this snapshot. They distinguish whole ships (including
the mast variant), front and back halves, upright/sideways/upside-down orientations, and degraded or
non-degraded condition. In Find and Layers, location type and template apply to the same ship;
multiple selected templates are alternatives. A whole-ship template can still be submerged or buried:
the template filter does not guarantee a ship floating at sea level. The inspector shows the native
template chosen by Minecraft, and template filters are preserved in saved conditions and layer presets.
Find also offers **Water placement (predicted)**: **Floating at water surface**, **Surface / shallow-water wreck**,
**Deck underwater**, and **Beached / on land**. This intersects the same ship's location type and template.
Floating requires an upright hull at the waterline, a dry deck, at least 95% water beneath the hull, and no
ground contact at any hull column. Shallow-water ships that rest on the seabed remain a separate category;
a mast above the water never makes a sunken ship qualify. The engine uses the native unrotated height-sampling
rectangle and the rotated template's actual hull geometry, with shared full terrain columns and aquifers.
These are base-terrain predictions: ice, surface decoration and overlapping structures can change the final world.
The inspector shows predicted keel/deck/water heights, hull contact and the adjusted ship box. Map tile requests
keep their fast template checks; water placement is evaluated only for a filtered search or an opened inspector.
Native Java `26.4-snapshot-2` fixture: seed **5645**, locate X **4064**, Z **1696**, whole non-degraded ship with mast,
predicted keel Y **60**, deck Y **64**, water Y **62**, 100% water coverage and one block of minimum keel clearance.
`python tests/shipwreck_placement.py` checks the predicted heights against Minecraft's actual `postProcess`
routine on independently generated base columns, including submerged, shallow and afloat cases and rotations.
The ruined portal chooser also offers five placement types: **on land surface**, **partly buried**,
**on ocean floor**, **in mountain**, and **underground**. These use the actual `VerticalPlacement` saved
by Minecraft's generated portal piece; they are not inferred from biome or height. Swamp portals use
the game's **on ocean floor** generation type even when they sit on dry land. In Find and Layers, biome
and placement filters apply together on the same portal. Minecraft's sixth placement, **in Nether**, is not offered because
this engine searches the Overworld.
**Huge ruined portals** is a separate search category and map layer, with the same biome and
placement options. It accepts only the game's three `giant_portal` templates, chosen with a
5% chance by this snapshot; size is read from the generated template rather than guessed from
the bounding box. **Ruined portals (any size)** still includes both sizes. Huge markers show
their size in the inspector, and enabling both layers draws each physical portal only once.
At normal layer zoom levels the two layers share portal tile requests and cached data.
When markers would overlap, the more important one keeps its icon and the others shrink to dots until
you zoom in. A layer that would need more than 600 markers in one map tile reports "too many here"
and shows only part of them; zoom in, or move that layer to a closer zoom level. Ocean monuments and
ruined portals are the slowest layers to compute (about 0.6–0.8 s per 8,192-block tile), so moving
them to Z1 or Z2 makes them slow to fill in.

**Presets.** A preset is a named copy of every layer setting (base map, terrain overlays, markers,
and each structure layer's switch and zoom level). *Recommended*, *Landmarks only*, *Loot run* and
*Terrain study* are built in; **Save** stores the current setup under a name in this browser, where it
can be selected or deleted later. Changing any setting shows the preset as *Custom*.

**Terrain.** The base map is biome colours or elevation tinting, with relief shading, contour lines,
the chunk/region grid and slime chunks (drawn when zoomed in, using the same seeded formula the engine
reports in the inspector) as overlays. The legend lists the biomes currently in view.

**Markers.** World spawn, the features that matched your search (white ring), and marker labels each
have a switch. Marker colour shows the group (settlements, ruins and temples, underground, ocean,
biome match); the icon shows the structure type.

Click any map location to highlight its block and open the inspector: block and chunk coordinates,
surface biome, base surface block and height, ground height, water depth, Nether coordinates and the native Java slime-chunk flag, with
buttons to copy the coordinates or a `/tp` command. Markers on the map come from the generation-point
check the game uses for `/locate`; clicking one builds that structure, outlines its footprint, and shows
its variant, height range, size and piece count.
Blue water can lie in a land biome, so the inspector lists the biome and surface separately.
The native base column identifies solid terrain and fluids; grass, sand and other surface materials
are assigned in later world-generation stages and are not predicted by this map.

**Go to** (the crosshair button, or **G**) travels to X/Z coordinates, or finds the nearest structure or
biome of a kind within 2,000 blocks of the map centre and pins it to the map.
The ten unsupported feature types listed in the coverage discussion have not been added as search filters.

Map loading streams each completed tile and abandons obsolete browser requests after panning.
Controlled measurements show about 25% less waiting for the first detailed tile, with complete-view
terrain time essentially unchanged. See [MAP-PERFORMANCE.md](MAP-PERFORMANCE.md) for measurements,
limitations and reproduction. Saved search worker counts above eight also survive page reloads.

## Licence

MIT; see `LICENSE`. Minecraft itself is not part of this project and is not distributed with it.
