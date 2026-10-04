# Roadmap

Where Seed Scout stands after 0.1.13 and what comes next. The plan is short on purpose: a few target wins, in
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

Before that: the seed search itself, the terrain map with relief and contours, structure layers, saved seeds
and the rare-find catalogue.

## Now

### 1. Shake-down of the installed app

Several desktop-only pieces were built without ever being run in an installed copy: the update prompt (Yes / No
and the remembered No), About and What's new, the import menu, the Settings panel's desktop buttons, and the
start-up error dialog with "Choose Minecraft folder".

- Walk through each once in the installed app and fix what misbehaves.
- Add a smoke test to the release workflow: start the packaged app, wait for the engine to be ready, fetch one
  tile, quit. A release that cannot start should fail the workflow instead of reaching users.

*Done when:* every item above has been seen working, and the workflow refuses to publish a build that does not
start.

### 2. Real heights for surface structures

0.1.13 predicts where a shipwreck ends up by running the game's own placement step on base terrain. The same
approach fits the other structures that are built at a placeholder height and moved onto the terrain later:
igloos, swamp huts, jungle temples, desert pyramids, ocean ruins and buried treasure. Today their card shows a
ground height and the teleport lands beside them on a guess.

- Compute the placed height and box for those types with the game's routine.
- Use it for the card, the map footprint and the teleport, so "beside it" is beside the real walls and buried
  treasure gives the chest's Y.

*Done when:* the card shows the placed Y for each of those types and a test compares it with the game's
routine, as the shipwreck one does.

### 3. Waypoint export

The card copies coordinates one at a time. Anyone who plays with a minimap wants the whole set in the game.

- Export a seed's matches and pins as a waypoint file for Xaero's Minimap and for JourneyMap, with names,
  colours taken from the marker colours, and the standing spot as the position.
- One button on the saved seed and one in the Layers panel ("Export what is on the map").

*Done when:* a file exported from Seed Scout loads in Xaero's Minimap and the waypoints sit on the structures.

## Next

### 4. Conditions on the spawn itself

Every condition today is a distance from an origin. Common wishes that cannot be expressed:

- **Spawn biome:** "spawn in a cherry grove", or "not in an ocean".
- **Either / or:** "a village or a pillager outpost within 300 blocks" as one condition.
- **Slime chunks:** "at least N slime chunks within 5 chunks of spawn", using the formula the map already has.

*Done when:* each of the three can be added in Find, searched, and shown on the result.

### 5. Search queue

A search holds the app until it finishes, and only one set of conditions runs at a time.

- Queue several condition sets (from saved presets) and run them one after another, each with its own budget.
- Survive a restart: a queue in progress resumes where it stopped.
- One notification when the whole queue is done, with matches per entry.

*Done when:* three presets can be queued, the app closed and reopened halfway, and all three finish.

### 6. Nether

The card already shows Nether coordinates, but the Nether itself is invisible.

- Nether structure layers (fortresses, bastions) drawn at their overworld-equivalent position, with the Nether
  coordinates on the card.
- Search conditions for them: "fortress within 300 Nether blocks of the spawn portal position".
- A Nether biome map can follow; structures first, since they decide whether a seed is worth playing.

*Done when:* a fortress and a bastion can be required in a search and are shown on the map.

## Later

- **Legend that points:** click a biome in the legend to highlight it on the map and jump to its nearest patch.
- **Height profile:** the measure tool shows the terrain profile along its line.
- **Map image export:** save the current view as a PNG with the markers and scale bar.
- **Named pins:** a name, a colour and a note on a pin, carried into the waypoint export.
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
