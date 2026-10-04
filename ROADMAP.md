# Roadmap

Where Seed Scout stands after 0.1.16 and what comes next. The plan is short on purpose: a few target wins, in
order, each with what "done" looks like.

## Shipped so far

| Version | What it added |
|---|---|
| 0.1.2 – 0.1.3 | Desktop app for Windows with bundled Python and Java, automatic releases, self-update |
| 0.1.4 | Compact feature card, PC usage setting |
| 0.1.5 | Biome-first map, sorting results by one feature, map priority during searches, data import |
| 0.1.6 | Smaller installer (136 → 106 MB), app icon, About, What's new |
| 0.1.7 | Minecraft version picker, updates that ask first |
| 0.1.8 | Shipwreck template filters for searches and map layers |
| 0.1.9 | Village (abandoned), igloo (basement) and ocean ruin (cluster) traits on the card and as search filters |
| 0.1.10 | First-run screen, start-up stages, readable errors, odds and time estimate, saved condition presets, finish notification, last view restored |
| 0.1.11 | Tags, filter and a copyable text card for saved seeds |
| 0.1.12 | Marker clusters, Settings panel, fast terrain detail, surface teleport for buried structures |
| 0.1.13 | Predicted water placement for shipwrecks (floating, shallow, deck underwater, beached), checked against the game's own placement routine |
| 0.1.14 | Conditions on the spawn itself (spawn biome, either/or alternatives, slime chunks near the origin); a self-test that drives every desktop dialog, run as a smoke test before each release |
| 0.1.15 | Search inside one seed: every place where the conditions hold, nearest first, out to the world border; stop, keep searching later, progress kept across restarts |
| 0.1.16 | Groups of one structure in the in-seed search ("3 ancient cities within 2,000 blocks"); biome searches two to five times faster with the same matches |

Before that: the seed search itself, the terrain map with relief and contours, structure layers, saved seeds
and the rare-find catalogue.

## Now

### 1. Whole-seed search, speed

A search inside a seed is bound by the game's own generation check, about 0.4 ms for every potential position of
the anchor structure, 60 to 110 of them in each 4,096-block region. On this PC that is half a day to the world
border for the rarest anchors and one to two weeks for common ones. What was tried in 0.1.16:

- **Kept:** placement arithmetic before any costly check (exact), and a cheaper first test inside the biome
  search (exact; two to five times faster where the biome is mostly absent, in seed searches too).
- **Not kept:** skipping regions on a coarse biome sample (lost 6–13% of places), and an exact biome pre-check
  ahead of the anchor (correct, but no faster than what it replaced).

What is left to try, each a larger piece of work:

- **A cheaper height for the generation check.** A third of the check is one full terrain column. The map
  already has a column that costs a third as much and differs in about 3 columns per million; used only as a
  first test, with the game's own check still deciding what is reported.
- **Confirming places on demand.** Building each reported structure costs about 0.3 s for a village. Reporting
  on the generation check and building when a place is opened would help searches with many places.
- **Many seeds, anywhere in each:** the two modes are separate. "Seeds that have this group within 5,000
  blocks of spawn" is the natural combination.

## Later

- **Nether:** fortresses and bastions as map layers at their overworld-equivalent position and as search
  conditions; a Nether biome map after that.
- **Legend that points:** click a biome in the legend to highlight it on the map and jump to its nearest patch.
- **Height profile:** the measure tool shows the terrain profile along its line.
- **Map image export:** save the current view as a PNG with the markers and scale bar.
- **Named pins:** a name, a colour and a note on a pin.
- **Shared seed links:** a link or string that opens a seed at a position with its pins, and importing one.

## Parked

Left alone until there is a reason to pick them up.

- **Teleport spots checked in a real world.** Needs a visit in the game per structure type. Item 2 removes
  most of the guesswork for surface structures.
- **Minecraft versions the engine does not compile against.** Needs a second, different version installed to
  build and test against.
- **Sharp terrain at the 200-block scale, faster.** Fast detail in Settings is the workaround. Three attempts
  at the sharp path did not help (a height-sliced whole tile was no faster; skipping the aquifer pass for open
  ocean broke sea-floor heights; more workers give about 15%).
- **Shipwreck loot** (which chests a template carries) and **an image version of the seed card**.
- **A browser-only build** (WebAssembly biome map without a server).
