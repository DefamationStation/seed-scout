# Seed-search optimization — 2026-10-04

For **woodland mansion within 100 blocks of the spawn region**, the new engine
searched the same 100,000 seeds **6.31× faster on four workers** and returned
identical results. It is active in the local web app. Search settings, previous
results, saved notes and catalogue contents were preserved across the restart.

| Engine | Workers | Seeds checked | Seconds | Seeds/second | Matches |
|---|---:|---:|---:|---:|---:|
| Baseline (`c99f556`) | 4 | 100,000 | 38.124 | 2,623 | 8 |
| Optimized | 4 | 100,000 | 6.046 | 16,541 | 8 |

Separate, longer worker-scaling measurements:

| Workers | Seeds checked | Seconds | Seeds/second | Matches |
|---:|---:|---:|---:|---:|
| 4 | 500,000 | 29.042 | 17,217 | 45 |
| 8 | 500,000 | 15.192 | 32,912 | 45 |
| 16 | 500,000 | 9.899 | 50,512 | 45 |
| 28 | 500,000 | 7.428 | 67,310 | 45 |

The complete sorted results were identical at all four worker counts, including
seed, spawn, structure coordinates, distance and full-start confirmation.
Measured data and the paired eight-match result sets are in
`tests/search-performance-2026-10-04.json`.

## Why this search was expensive

Every seed previously constructed its seeded generation state and ran vanilla's
entire spawn search before asking whether a mansion placement could be within
100 blocks. This does unnecessary work on the overwhelming majority of seeds.

Of 15,410 worker execution samples in the baseline JFR, 10,911 had
`GradientNoise.permute` at the top of the stack. Noise sampling, rather than HTTP
or browser rendering, was the primary cost. The original code also reparsed and
sorted the same conditions for every seed.

The installed snapshot's `NoiseSpawnFinder` has two stages:

1. Score the origin and radial points at 512-block increments up to 2,048 blocks.
2. Around that coarse winner, score radial points at 32-block increments up to
   512 blocks. The centre stays fixed throughout this second stage.

The best score wins; equal scores retain the earlier point. The resulting block
position becomes the generator's spawn chunk, and Seed Scout reports its centre.

## The rework

`SpawnSearch` performs the same coarse search, then obtains a conservative list
of potential structure placements around its winner. Placement coordinates are
cheap: the game computes them from seed, region, spacing and salt without terrain
noise. The list uses the game's own placement methods and locate offsets, and
allows eight blocks for conversion from a spawn point to a chunk centre.

In the fine phase, it first scores every position whose spawn-chunk centre could
satisfy a required nearby-structure condition. It then visits the other positions
until one defeats the best eligible point. Such a seed can be rejected immediately:
no later point could make the best eligible score become the global winner.
If none defeats it, the exact vanilla winner is returned.

Original point indices preserve first-wins ties despite the changed evaluation
order. Float angle accumulation, integer truncation, quart-coordinate rounding,
noise functions, fitness arithmetic and chunk-centre conversion match the
installed `26.4-alpha.2` code. Density samplers are bound once per seed, using a
seed-local cached sampler context, and the context is cleared after use.

The geometry gate is only a **necessary condition**. Passing it still runs the
existing generation-point checks, biome/variant filters, dependent conditions,
and full structure-start construction before reporting a match. It cannot turn
a potential placement into a reported structure by itself.

The gate applies to positive, independent structure conditions with radius at
most 256 and random-spread spacing at least 32 chunks. It picks one selective
condition when several qualify. Custom-origin searches, exclusions, dependent
conditions, biome-only searches and unsupported placements use the original
spawn path. Counts and minimum distances are respected. Conditions are now
parsed and sorted once per search job rather than once per seed.

This is tied to the installed snapshot's spawn algorithm. Revalidate against the
native finder before porting it to another Minecraft version.

## Validation

- Same 100,000 input seeds: all eight matches and their complete result objects
  match the original engine.
- 12,600 differential comparisons with **Minecraft's native `getOrigin`**:
  sequential and random seeds, negative seeds including the signed lower bound,
  mansion/monument gates, radii 0–256, minimum distances, count-two conditions,
  and an allow-every-position gate. All passed; 894 geometry-surviving origins
  were compared directly. Rejected cases were checked against the native winner,
  so the test covers false-negative rejection as well as returned coordinates.
- All 19 existing HTTP integration tests passed in an isolated instance, covering
  stop/resume, budgets, counts, exclusions, relative conditions, biome modes,
  map queries, full-start confirmation, variants, saved notes and catalogue reuse.
- Corrected an existing stale test that expected the map-worker cap to be eight.
  The baseline already used the documented cap of sixteen; production map-worker
  behavior was not changed here.
- The live app was idle when restarted. Its results and request were compared
  before/after, saved notes were compared byte-for-byte, and the catalogue's
  logical SQLite contents were compared. A live API check confirmed the known
  mansion at (384,240), 34 blocks from the reported spawn centre (408,264).

## Benchmark conditions and limits

Minecraft 26.4 Snapshot 2 (`26.4-alpha.2`), Java 25.0.4.1, i9-13900HX with
32 hardware threads, 6 GiB heap. Seed range starts at `-3811937398911544709`.
Each engine receives a 10,000-seed warmup. The paired runs use the same JFR
settings; the scaling run does not record JFR. All budgets are exhausted, with a
high match limit so the search does not stop early. Catalogue reuse is bypassed.
No map requests or other benchmark workloads run concurrently.

The unchanged baseline classes and source were snapshotted before editing.
Benchmarks launch separate JVMs and isolated working directories, without calling
the live app's search endpoint or modifying its stored data. Scaling measurements
run sequentially in one warmed JVM, so JIT/thermal effects can affect the numbers.
These are single-run observations, not confidence intervals or guaranteed rates.

The user's previous four-worker run showed about 1,620 seeds/second. The controlled
baseline was faster at 2,623; warmup, concurrent map activity and run conditions
can explain differences, so the claimed code speedup uses the measured baseline.

For this query, 16 workers gave about 50,500 seeds/second while leaving more CPU
capacity available than the 28-worker setting, which reached about 67,300.
The app retains the user's four-worker choice. Map generation or Minecraft running
at the same time will compete for CPU. Wider radii and biome-heavy conditions
will not necessarily see this speedup.

Distances retain the app's existing meaning: **the generator's spawn region**.
Final player spawn can shift after terrain checks; this optimization does not
make a new guarantee about the final player's position.

## Reproduce

```powershell
python build.py
python tests/spawn_search.py
python tests/isolated_integration.py
python tests/search_performance.py --classes runtime/classes --output runtime/search-bench/new-run --threads 4 8 16 28 --limit 500000
```

Choose a new output directory for each benchmark. To compare an older engine,
pass a saved class directory with `--classes`; use the same installed game and
libraries. Raw logs, JFR, baseline classes and pre-restart backups remain in the
ignored `runtime/search-bench/` directory.
