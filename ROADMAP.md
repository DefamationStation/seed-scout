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

## Next

1. **Biome-first map at every zoom.** The 200-block scale still takes about 6 seconds for a full-HD view.
   Draw the quick biome map immediately at all zooms and let height, relief and true water fill in on top,
   so panning never waits on terrain.
2. **Teleport you can trust.** The standing spot is computed from terrain and piece boxes, not placed blocks.
   Check every structure type in a real world, fix the ones that land inside a block, and add a safe variant
   (a few blocks up, with slow falling) for the types that stay uncertain.
3. **Results you can act on.** Per result: open in map, copy seed, and a one-line summary of distances.
   Sorting by one chosen feature's distance instead of only the total.
4. **First-run import.** The installed app starts with empty data. Offer to import saved seeds and the
   rare-find catalogue from a checkout or another install.
5. **Search and map together.** While a search runs, give the map a small fixed share of the workers
   automatically and return it afterwards, so neither starves the other whatever the preset.

## Reach

6. **More than one Minecraft version.** Only 26.4-snapshot-2 works today. A version picker that lists what is
   installed and says which versions are supported, with the engine's version-specific calls isolated so a new
   snapshot is a small patch.
7. **Signed installer.** Windows and Edge still warn on download, and Defender has flagged a build. Code-sign
   through SignPath's open-source programme or a certificate.
8. **Smaller download.** The installer is about 136 MB. Trim the Java runtime further and drop unused
   Electron locales.
9. **App identity.** A real icon, an About box with version and licence, and release notes shown after an
   update.

## Later

- **Shareable links.** A link or copyable string that opens a seed at a map position with its pins.
- **Other dimensions.** Nether and End maps, starting with Nether structures, since the card already shows
  Nether coordinates.
- **Route planning.** Multi-point paths in the measure tool, with Nether-travel distances.
- **In the browser.** A WebAssembly port of the biome layer for a hosted, serverless map. The Java engine stays
  the reference for correctness.
