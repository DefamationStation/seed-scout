# Roadmap

Where Seed Scout stands after 0.1.15 and what comes next. The plan is short on purpose: a few target wins, in
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

Before that: the seed search itself, the terrain map with relief and contours, structure layers, saved seeds
and the rare-find catalogue.

## Now

### 1. Whole-seed search, second pass

0.1.15 added *Inside one seed*: every place in one world where the conditions hold, nearest first, out to the
world border. What it does not do yet:

- **Speed for the whole world.** A group search covers about 300–400 regions (4,096 blocks square) a second on
  this PC, which reaches 100,000 blocks in a few seconds, 1,000,000 in about ten minutes and the world border in
  about a week. Rarer anchors are faster. The next step is skipping regions that cannot match: a coarse
  climate pass for biome conditions, and testing the cheapest other condition before the anchor is checked.
- **Same-type groups:** "three ancient cities within 2,000 blocks of each other". The anchor is one structure;
  a count of the same type around it is not offered.
- **Biome anchors report one place per region** (4,096 blocks), the patch nearest the origin, and sample every
  64 blocks, so a patch smaller than that can be passed over.
- **Many seeds, anywhere in each:** the two modes are separate. Combining them ("seeds that have this group
  within 5,000 blocks of spawn") is the natural follow-up.

*Done when:* a whole-world group search finishes in about a day, and same-type groups can be asked for.

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
