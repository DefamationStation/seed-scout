# Roadmap

What comes next for Seed Scout, in the order it is planned. Items are specific to what the app does today.

## Done

- **Compact feature card.** Selecting something on the map shows a small card: name, X Y Z, one line on where
  it sits (buried, under water, ground height) and the copy buttons. Everything else is under *More details*,
  which remembers whether it was open.
- **PC usage setting.** *Search controls* has a PC usage preset (Quiet, Balanced, Maximum) that sets search
  workers and map workers together; each can also be set on its own. Map workers apply at once and are
  remembered. Engine memory now follows the machine (half its RAM, 2 to 6 GB) instead of a fixed 6 GB.
- **Installer and updates.** Windows installer built and published by the release workflow; installed copies
  update themselves from it.
- **Biome-first map.** A terrain view starts as the quick biome map at a quarter of its resolution, which
  arrives in about a tenth of a second, and terrain fills in on top.
- **Sort results by one feature.** With several conditions, *Sort by* orders the found worlds by the nearest
  match of one of them instead of the closest overall.
- **Search and map together.** Search workers run just below normal priority and map workers just above, so
  the map stays quick during a search on every core and the search loses nothing when the map is idle.
- **Import.** In the desktop app, *File → Import saved seeds and catalogue…* copies them from a checkout or
  another install's data folder (the current ones are kept as `.bak`).

- **Smaller download.** The bundled Java runtime holds only the modules world generation uses, Python comes
  without OpenSSL, and Electron ships one language.
- **App identity.** The app has its own icon, *Help → About Seed Scout*, and *What's new*, which also opens
  by itself the first time a new version starts. Release notes list the changes since the previous version.

- **Minecraft version picker.** The version shown at the top of the app is now a list of the installed
  versions. Picking one compiles the engine against it and restarts on it; a version whose world-generation
  code differs is refused with the reason and nothing changes. The choice is remembered.
- **Updates ask first.** A new version is offered with Yes or No. No is remembered across restarts: nothing is
  offered again until you update from *Help → Check for updates*, which sits above *About* and shows the
  version on offer. *About* shows the app version, the update state and the Minecraft version in use.

- **Village, igloo and ocean ruin detail.** A confirmed village says when it is abandoned (zombie), an igloo
  whether it has a basement, and an ocean ruin whether it is a single ruin or a cluster and of how many. Shown
  on the feature card and on search results.
- **Search by these traits.** The chooser for villages (Inhabitants), igloos (Basement options) and ocean
  ruins (Sizes) filters a search condition, the same way shipwreck templates do: "igloo with basement within
  500 blocks". Map layers cannot be filtered by them, because map markers are not built.

- **First-run screen.** The empty map greets with the Minecraft version in use and two one-click starts: a
  starter search and a random seed. In the desktop app it also points at the import menu.
- **Start-up progress.** The loading screen names the stage (checking the install, compiling the engine), and
  the page says it is loading the game's world generation until the engine is ready.
- **Clearer errors.** A missing, partly downloaded or unsupported Minecraft version is explained in a sentence
  with what to do, and the desktop app offers to choose another Minecraft folder or open the log.
- **Odds and time before starting.** When the same conditions were searched before, the Find panel shows how
  rare they were and roughly how long the wanted number of results will take.
- **Saved condition presets**, beside the three built-in ones.
- **A system notification when a long search finishes**, or one that ends while the window is out of sight.
- **The last seed and view come back** when the app opens.
- **Approximate height on overview zooms** in the status bar, marked with ≈.

- **Tags and a filter for saved seeds.** Each saved seed takes up to ten tags; the list filters by tag, note,
  seed or feature.
- **Copy a seed card.** One button copies a text card: seed, version, spawn, feature coordinates, tags and
  notes. An image card is not done.

## Next

### Templates and variants

1. **Shipwreck loot.** Templates are now a filter and shown on the card; which chests a template carries
   (treasure, map, supply) is not shown yet.

### Map

2. **Marker clustering** at wide zooms, in place of overlapping dots.

### Housekeeping

3. **Settings in one place.** PC usage is inside Search controls, the Minecraft folder in the File menu and
    updates in Help; one settings panel for all three.
4. **Teleport you can trust.** The standing spot is computed from terrain and piece boxes, not placed blocks.
    Check every structure type in a real world, fix the ones that land inside a block, and add a safe variant
    (a few blocks up, with slow falling) for the types that stay uncertain.
5. **Versions beyond the engine's own.** The picker accepts any version the engine still compiles against.
    Supporting ones where it does not means moving the engine's version-specific calls behind one small layer
    per version. This needs a second, different version installed to build and test against.
6. **The 200-block scale.** Still the slowest view, and three attempts did not change that, so it is parked:
    - a whole tile computed over a slice of the height range matched the game but was no faster (14.8 against
      13.7 ms per tile);
    - accepting open-ocean columns without the aquifer pass gained 3–5% and got about 400 sea-floor heights
      per 800,000 wrong;
    - more map workers help a little (about 15% from 16 to 24 on a 32-thread PC, nothing beyond), which the
      Maximum preset now uses.
    What would move it is fewer samples at that zoom (a coarser look) or a hand-written height calculation
    that shares work between neighbouring columns, which the game's own classes do not allow.

## Later

- **Shareable links.** A link or copyable string that opens a seed at a map position with its pins.
- **Other dimensions.** Nether and End maps, starting with Nether structures, since the card already shows
  Nether coordinates.
- **Route planning.** Multi-point paths in the measure tool, with Nether-travel distances.
- **In the browser.** A WebAssembly port of the biome layer for a hosted, serverless map. The Java engine stays
  the reference for correctness.
