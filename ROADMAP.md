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

## Next

### Templates and variants

1. **Shipwreck templates.** Which hull it is, whether it is beached and which chests it carries, as a filter
   and on the card. *In progress in a separate thread.*
2. **Village, igloo and ocean ruin detail.** Zombie villages, igloos with a basement, and single ruins against
   clusters, shown on the feature card and on search results.
3. **Search by template.** Filter a condition by these the way variants and portal placement work today
   ("igloo with basement within 500 blocks"). Builds on the shipwreck template filter once that lands.

### First run and empty states

4. **A first-run screen** in the desktop app: the Minecraft version it found, a one-click starter search and
   the import offer, instead of opening straight onto the form.
5. **Engine start-up progress.** The loading screen shows one line for 10–15 seconds; show the real stages
   (compiling, loading the game's data, ready).
6. **Clearer errors.** An unsupported version or a missing library shows compiler text; give a plain sentence
   and what to do about it.

### Search

7. **Time and odds before starting.** "About 1 in 40,000, roughly 9 minutes at this speed", from the rarity
   the catalogue already records.
8. **Condition presets you can save**, beside the three built-in ones.
9. **A notification when a long search finishes**, in the desktop app.

### Map

10. **Biome search on the map.** "Nearest cherry grove from here", drawn as a marker with a line.
11. **Biome and height under the pointer on overview zooms.** Height is hidden there today.
12. **Remember the last opened seed and view** between sessions.
13. **Marker clustering** at wide zooms, in place of overlapping dots.

### Saved seeds

14. **Tags and a filter**, in addition to free-text notes.
15. **Export a seed as a card** (image or text): seed, version and key coordinates.

### Housekeeping

16. **Settings in one place.** PC usage is inside Search controls, the Minecraft folder in the File menu and
    updates in Help; one settings panel for all three.
17. **Teleport you can trust.** The standing spot is computed from terrain and piece boxes, not placed blocks.
    Check every structure type in a real world, fix the ones that land inside a block, and add a safe variant
    (a few blocks up, with slow falling) for the types that stay uncertain.
18. **Versions beyond the engine's own.** The picker accepts any version the engine still compiles against.
    Supporting ones where it does not means moving the engine's version-specific calls behind one small layer
    per version. This needs a second, different version installed to build and test against.
19. **The 200-block scale.** Still the slowest view, and three attempts did not change that, so it is parked:
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
