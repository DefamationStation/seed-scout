# Map loading measurements, 4 October 2026

The change improves how soon detailed terrain appears. It does **not** materially increase terrain-generation throughput or reduce the time to finish every tile.

## Controlled browser results

Means of three fresh views per case in foreground Edge on the user's i9-13900HX. Same seed `-3811937398911477122`, viewport 895 × 852 CSS pixels, 3 blocks per pixel, 8 blocks per terrain sample, 16 map workers, no seed search. Structure markers were disabled to isolate terrain loading. Browser HTTP caching was disabled, the isolated server's tile cache was cleared before each view, and each client visited fresh coordinates. Both versions used the same warmed Java engine and identical terrain code.

| Measurement | Original | Streaming | Change |
|---|---:|---:|---:|
| First detailed tile, cold view | 284.2 ms | 209.2 ms | 26.4% less waiting |
| First detailed tile after interrupted pan | 284.8 ms | 215.9 ms | 24.2% less waiting |
| Every detailed tile, cold view | 1,259.4 ms | 1,261.7 ms | Essentially unchanged |
| Every detailed tile after interrupted pan | 1,167.9 ms | 1,188.6 ms | 1.8% slower in these samples |

The interrupted-pan case begins loading a view 20,000 blocks away, then moves to the measured destination after 220 ms. Timing starts at that final move. A coarse biome preview already appears before the first detailed tile. Completion means terrain is complete, not structure markers.

These are small samples, not confidence intervals. View size, terrain, CPU contention and browser visibility affect results. Preliminary foreground runs with normal structure layers took 1.31–1.63 seconds per complete terrain view; rasterization itself used roughly 63–126 ms. Occluded-window measurements were slower and excluded from the controlled comparison.

Raw paired measurements: [map-performance-2026-10-04.json](tests/map-performance-2026-10-04.json).

## Findings and changes

- Native generation remains the main cost: each detailed tile samples 1,024 terrain columns. The existing quick preview, native noise sharing at close zoom, zoom-dependent resolution and caches already help.
- Previously a batch returned only when its slowest tile finished. `/api/tile-stream` sends indexed newline-delimited JSON as each tile finishes. The client displays completed tiles independently, retaining the same biome, elevation and water data.
- Three terrain requests and bounded batches keep work queues short. Entirely obsolete streams are aborted after a pan settles. Loading starts independently of animation-frame callbacks. The server cancels queued Python futures when it detects disconnection; already-running native calculations finish and remain cached. This is not full native cancellation.
- A deeper queue slightly helped cold completion but worsened panning. It was discarded in favor of approximately 24 outstanding terrain tiles on this machine.
- Streaming uses uncompressed local NDJSON. Client and server tile caches remain; complete streams are not saved in the browser HTTP cache. The compressed batch endpoint remains available. Refreshed pages automatically fall back to it when an older app process is running.
- Native sampler and whole-tile density-volume experiments did not improve performance and were discarded. Terrain calculation and resolution remain unchanged.
- Saved worker counts above eight were lost on page initialization because the initial select lacked those options. All supported choices now exist before hardware filtering, allowing 16 to survive reloads.

## Validation

- 10 map HTTP tests, including identical decoded stream/batch data at terrain steps 1 and 8 and quick step 32, plus native-column comparisons.
- 3 protocol tests: fast tiles arrive ahead of a blocked first tile; one failed tile does not discard other server results; malformed batches are rejected.
- JavaScript checks for incremental display, obsolete-request cancellation, bounded concurrency and eventual complete viewport loading.
- All 19 existing integration tests and 1,000 existing terrain-alignment checks.
- Live page compatibility with the older running backend, including batch fallback and retained 16-worker preference.

## Reproduction

Save the original `web/map.js` before editing; this task's copy is under ignored `runtime/map-bench/baseline/map.js`. From the project directory run:

```powershell
python tests/map_benchmark_server.py --baseline-map runtime/map-bench/baseline/map.js
```

Open `http://127.0.0.1:8880/baseline.html` for the old loader or `/` for the new one. Open the seed above through the interface and use the same panel and viewport. Disable browser HTTP caching, then evaluate `tests/map_browser_bench.js` in the developer console. Run `benchMap(x, 3, false)` at x = 2000000, 2100000, 2200000 and `benchMap(x, 3, true)` at x = 2300000, 2400000, 2500000. Reload between versions to clear client tiles. Cache reset exists only in the isolated test server.

`tests/tile_benchmark.py` separately measures native generation in an isolated JVM with saved classes and output digests. Those timings are not complete browser loading times.

## Activation

Code and verification are complete. Automatic approval review rejected the combined backup/restart command with `blocked by policy`; the live Python backend was not restarted. The refreshed page remains functional through its batch fallback. Close the live app and run `Launch Seed Scout.cmd` to activate streaming. Benchmarks did not replace search results, saved seeds, the catalogue or worker preferences.
