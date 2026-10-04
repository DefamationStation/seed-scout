// Self-test for the desktop shell, started with --selftest=<scenario>. Dialogs are answered by a script instead
// of a person, every dialog shown is recorded, and the result is written to selftest.json in the user data folder.
// The exit code is 0 when every check passed.
//
//   smoke        No Minecraft needed (this is what the release workflow runs). Points the app at a folder that
//                looks like a Minecraft install but is not one: the bundled Python must start the backend, the
//                bundled Java must be found, and the "could not start" dialog must say why in plain words.
//   nominecraft  An empty folder: the app must ask for the Minecraft folder instead of starting.
//   full         Needs Minecraft installed. Engine ready, a tile, About, What's new, the Settings links,
//                import, and the whole update conversation (No is remembered, a manual check asks again).
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

exports.install = (mode, shell) => {
  const { app, dialog, Menu } = shell;
  const userData = app.getPath('userData'), checks = [], shown = [], answers = [];
  let openFolder = '', finished = false;
  const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); shell.log(`[selftest] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`); };
  function finish() {
    if (finished) return;
    finished = true;
    const ok = checks.length > 0 && checks.every(c => c.ok);
    fs.writeFileSync(path.join(userData, 'selftest.json'), JSON.stringify({ mode, ok, version: app.getVersion(), checks, dialogs: shown.map(d => d.message) }, null, 2));
    shell.quit(ok ? 0 : 1);
  }
  const sleep = ms => new Promise(done => setTimeout(done, ms));
  async function until(test, seconds, what) {
    for (let i = 0; i < seconds * 4; i++) { const value = await test(); if (value) return value; await sleep(250); }
    throw new Error(`timed out waiting for ${what}`);
  }

  // ---- Scripted dialogs ----------------------------------------------------
  // The answer to a dialog: one queued for its message, else a safe default that never downloads or deletes.
  function answer(options) {
    shown.push({ message: options.message || '', detail: options.detail || '', buttons: options.buttons || [] });
    const queued = answers.findIndex(a => (options.message || '').includes(a.message));
    if (queued >= 0) return answers.splice(queued, 1)[0].button;
    const text = options.message || '';
    if (text.includes('could not start')) return 2;                       // Quit
    if (text.includes('No Minecraft install')) return 1;                  // Quit
    if (text.includes('Update Seed Scout to')) return 1;                  // No
    if (text.includes('is ready')) return 1;                              // Later
    return 0;
  }
  dialog.showMessageBox = async (...args) => {
    const response = answer(args[args.length - 1]);
    return { response };
  };
  dialog.showMessageBoxSync = (...args) => {
    const options = args[args.length - 1], response = answer(options);
    // These two end the app, so the scenario is judged here, before it quits.
    if (mode === 'smoke' && options.message.includes('could not start')) {
      check('backend ran on the bundled Python and reported why it stopped', /is not installed/.test(options.detail), options.detail);
      check('bundled Java was found', !/Java was not found/.test(options.detail));
      check('the dialog offers another folder and the log', options.buttons.length === 3, options.buttons.join(' | '));
      setImmediate(finish);
    }
    return response;
  };
  dialog.showOpenDialog = async () => ({ canceled: !openFolder, filePaths: openFolder ? [openFolder] : [] });
  const lastDialog = text => [...shown].reverse().find(d => d.message.includes(text));

  // ---- Scenario set-up -----------------------------------------------------
  const scratch = path.join(userData, 'selftest-files');
  fs.mkdirSync(scratch, { recursive: true });
  if (mode === 'smoke') {
    const fake = path.join(scratch, 'not-minecraft', 'versions', 'placeholder');
    fs.mkdirSync(fake, { recursive: true }); fs.writeFileSync(path.join(fake, 'placeholder.jar'), '');
    shell.saveSettings({ minecraft: path.join(scratch, 'not-minecraft') });
  }
  if (mode === 'nominecraft') {
    fs.mkdirSync(path.join(scratch, 'empty'), { recursive: true });
    shell.saveSettings({ minecraft: path.join(scratch, 'empty') });
  }
  setTimeout(() => { check('finished in time', false, 'the self-test did not finish within three minutes'); finish(); }, 180000).unref();

  const get = async route => (await fetch(shell.backendUrl() + route)).json();

  async function full() {
    await until(async () => shell.backendUrl() && (await get('/api/status').catch(() => null))?.ready, 150, 'the engine');
    check('engine ready', true, (await get('/api/versions')).current);
    const tile = await get('/api/tile?seed=123&x=0&z=0&step=8&mode=terrain');
    check('terrain tile', tile.biomes?.length === 1024);

    await shell.showAbout();
    const about = lastDialog('Seed Scout version');
    check('About shows the app and Minecraft versions', about && about.detail.includes(app.getVersion()) && /Minecraft version in use: \S+/.test(about.detail), about?.detail);

    await shell.showReleaseNotes();
    check("What's new opens", !!lastDialog("What's new in Seed Scout"), lastDialog("What's new in Seed Scout")?.detail);

    const before = shown.length;
    check('Settings link: about', shell.shellAction('seedscout://about') === true);
    await until(() => shown.length > before, 10, 'the About dialog from the Settings link');
    check('Settings link: unknown action is ignored', shell.shellAction('seedscout://nonsense') === false);
    check('Settings link: web pages go to the browser, not the shell', shell.shellAction('https://example.com/', true) === 'external');

    // Import: a folder holding one saved seed replaces the app's (empty) list, and the engine comes back.
    openFolder = path.join(scratch, 'import-from'); fs.mkdirSync(openFolder, { recursive: true });
    fs.writeFileSync(path.join(openFolder, 'saved-seeds.json'), JSON.stringify([{ seed: '424242', note: 'self-test', saved: '2026-01-01 00:00' }]));
    const address = shell.backendUrl();
    await shell.importData();
    await until(async () => shell.backendUrl() && shell.backendUrl() !== address && (await get('/api/status').catch(() => null))?.ready, 150, 'the engine after import');
    const saved = (await get('/api/saved')).seeds || [];
    check('import brings saved seeds over', saved.some(s => s.seed === '424242'), JSON.stringify(saved).slice(0, 120));
    openFolder = '';

    // Updates: No is remembered, automatic offers stop, a manual check asks again, Yes downloads.
    const updates = shell.updates();
    if (!updates) check('update conversation', false, 'the updater is only created in a packaged build');
    else {
      let downloads = 0;
      updates.stubDownload(() => { downloads++; return Promise.resolve(); });
      shell.saveSettings({ updates: 'ask' });
      const offers = () => shown.filter(d => d.message.includes('Update Seed Scout to 9.9.9')).length;
      updates.simulate('update-available', { version: '9.9.9' });
      await until(() => shell.settings().updates === 'manual', 10, 'the remembered No');
      check('an update is offered with Yes and No', offers() === 1 && lastDialog('Update Seed Scout to').buttons.join() === 'Yes,No');
      check('No is remembered', shell.settings().updates === 'manual' && downloads === 0);
      updates.simulate('update-available', { version: '9.9.9' }); await sleep(600);
      check('nothing is offered again automatically', offers() === 1);
      check('the Help menu shows the version on offer', menuLabels(Menu).some(label => label === 'Update to 9.9.9…'), menuLabels(Menu).join(' | '));
      answers.push({ message: 'Update Seed Scout to', button: 0 });
      updates.simulate('update-available', { version: '9.9.9' }, true);
      await until(() => downloads === 1, 10, 'the download after Yes');
      check('a manual check asks again and Yes downloads', offers() === 2 && shell.settings().updates === 'ask');
      updates.simulate('update-downloaded', { version: '9.9.9' });
      await until(() => lastDialog('Seed Scout 9.9.9 is ready'), 10, 'the restart prompt');
      await sleep(300);
      check('a downloaded update offers to restart', menuLabels(Menu).some(label => label === 'Restart to update to 9.9.9'), menuLabels(Menu).join(' | '));
    }
    await new Promise(done => execFile(path.join(process.resourcesPath, 'jdk', 'bin', 'java.exe'), ['-version'], error => { if (app.isPackaged) check('bundled Java runs', !error, error?.message); done(); }));
  }
  const menuLabels = M => (M.getApplicationMenu()?.items || []).flatMap(item => (item.submenu?.items || []).map(sub => sub.label));

  return {
    // Called when the app decides it cannot continue without a Minecraft folder.
    noFolder() {
      const asked = lastDialog('No Minecraft install was found');
      if (mode === 'nominecraft') { check('asks for the Minecraft folder when none is found', !!asked && asked.buttons[0].startsWith('Choose Minecraft folder'), asked?.detail); }
      else check('found a Minecraft folder', false, asked?.detail || 'no folder');
      finish();
    },
    // Called once the backend has been started.
    started() {
      if (mode === 'nominecraft') { check('asks for the Minecraft folder when none is found', false, 'the app started a backend instead'); return finish(); }
      if (mode === 'full') full().catch(error => check('self-test ran to the end', false, error.stack || error)).finally(finish);
      // smoke: the "could not start" dialog judges the run.
    },
  };
};
