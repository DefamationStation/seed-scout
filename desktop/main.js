// Desktop shell: starts the local Seed Scout backend, shows its page in a window, and keeps the app up to date.
const { app, BrowserWindow, Menu, Notification, dialog, shell } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// The version the engine was written against; the backend falls back to another installed one when it is missing.
const SUPPORTED_VERSION = '26.4-snapshot-2';
const UPDATE_INTERVAL = 4 * 60 * 60 * 1000;
const REPOSITORY = 'DefamationStation/seed-scout';

let window = null, backend = null, backendUrl = '', quitting = false, logStream = null, updateReady = false, updateAvailable = '';

// Installed, everything the backend needs sits beside the app. From a checkout it uses the repository and this machine's tools.
const packaged = app.isPackaged;
const appRoot = packaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..');
const python = packaged ? path.join(process.resourcesPath, 'python', 'python.exe') : (process.env.SEED_SCOUT_PYTHON || 'python');
const jdk = packaged ? path.join(process.resourcesPath, 'jdk') : (process.env.SEED_SCOUT_JDK || '');
// Saved seeds, the catalogue and the compiled engine live here, where an update does not touch them.
const dataDir = () => path.join(app.getPath('userData'), 'data');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function settings() { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; } }
function saveSettings(patch) { fs.writeFileSync(settingsFile(), JSON.stringify({ ...settings(), ...patch }, null, 2)); }
function log(text) { logStream?.write(text.endsWith('\n') ? text : text + '\n'); }

const defaultMinecraft = () => path.join(app.getPath('appData'), '.minecraft');
// A usable Minecraft folder has at least one downloaded version; which one is used is chosen inside the app.
function hasVersion(folder) {
  try { return fs.readdirSync(path.join(folder, 'versions')).some(name => fs.existsSync(path.join(folder, 'versions', name, `${name}.jar`))); }
  catch { return false; }
}

// The Minecraft folder to read: the saved choice, else the launcher's default. Asks when the version is not there.
async function minecraftFolder(forceAsk = false) {
  let folder = settings().minecraft || defaultMinecraft();
  while (forceAsk || !hasVersion(folder)) {
    const { response } = await dialog.showMessageBox(window, {
      type: forceAsk ? 'question' : 'warning', buttons: ['Choose Minecraft folder…', forceAsk ? 'Cancel' : 'Quit'], defaultId: 0, cancelId: 1,
      message: forceAsk ? 'Choose your Minecraft folder' : 'No Minecraft install was found',
      detail: `Seed Scout reads the game's own world generation from your install. It was written for ${SUPPORTED_VERSION}; the version is chosen at the top of the app.\n\n` +
        `Current folder: ${folder}\n\nInstall a version in the Minecraft Launcher (run it once so its files download), or choose the folder that contains "versions" and "libraries".`,
    });
    if (response !== 0) return forceAsk ? null : undefined;
    const picked = await dialog.showOpenDialog(window, { title: 'Minecraft folder', defaultPath: folder, properties: ['openDirectory'] });
    if (picked.canceled) { if (forceAsk) return null; continue; }
    folder = picked.filePaths[0];
    if (hasVersion(folder)) { saveSettings({ minecraft: folder }); return folder; }
    forceAsk = false;
  }
  return folder;
}

function startBackend(minecraft) {
  backendUrl = '';
  const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', SEED_SCOUT_DATA: dataDir(), SEED_SCOUT_MINECRAFT: minecraft };
  if (jdk) env.SEED_SCOUT_JDK = jdk;
  // Port 0 lets the system pick a free port; the backend prints the address it ended up on.
  const child = backend = spawn(python, [path.join(appRoot, 'app.py'), '--port', '0', '--no-browser'], { cwd: dataDir(), env, windowsHide: true });
  let tail = '', failure = '';
  const read = chunk => {
    const text = chunk.toString(); log(text); tail = (tail + text).slice(-4000);
    // The backend says what it is doing, and in plain words why it could not start.
    const stage = /Seed Scout stage: (.+)/.exec(text), error = /Seed Scout error: (.+)/.exec(text);
    if (stage && !backendUrl) window?.webContents.executeJavaScript(`document.getElementById('stage') && (document.getElementById('stage').textContent = ${JSON.stringify(stage[1] + '…')})`).catch(() => { });
    if (error) failure = error[1].trim();
    const found = !backendUrl && /Seed Scout: (http:\/\/127\.0\.0\.1:\d+)/.exec(tail);
    if (found) { backendUrl = found[1]; window?.loadURL(backendUrl); }
  };
  child.stdout.on('data', read); child.stderr.on('data', read);
  child.on('error', error => read(`Could not start the backend: ${error.message}\n`));
  child.on('exit', code => {
    if (backend !== child) return;
    backend = null;
    if (quitting) return;
    // The page's own power button stops the backend; that closes the app. Anything else is a failure worth showing.
    if (backendUrl && code === 0) return app.quit();
    const choice = dialog.showMessageBoxSync(window, {
      type: 'error', message: 'Seed Scout could not start', buttons: ['Choose Minecraft folder…', 'Open log', 'Quit'], defaultId: 0, cancelId: 2,
      detail: failure || `The engine stopped while starting (code ${code}). The last lines of its output:\n\n${tail.trim().split('\n').slice(-8).join('\n')}`,
    });
    if (choice === 0) return changeMinecraft().then(() => { if (!backend) app.quit(); });
    if (choice === 1) shell.openPath(path.join(app.getPath('userData'), 'desktop.log'));
    app.quit();
  });
}

function stopBackend() {
  const child = backend; backend = null;
  if (!child) return;
  // The backend closes the Java engine itself when asked; the process tree is ended after that in case it could not.
  const kill = () => execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => { });
  if (!backendUrl) return kill();
  fetch(`${backendUrl}/api/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ok":true}' }).catch(() => { }).finally(() => setTimeout(kill, 1500));
}

async function changeMinecraft() {
  const folder = await minecraftFolder(true);
  if (!folder) return;
  stopBackend(); window.loadFile(path.join(__dirname, 'loading.html')); startBackend(folder);
}

// Brings saved seeds and the rare-find catalogue over from a checkout or another install's data folder.
async function importData() {
  const picked = await dialog.showOpenDialog(window, { title: 'Folder that holds saved-seeds.json or catalogue.db', properties: ['openDirectory'] });
  if (picked.canceled) return;
  const from = picked.filePaths[0], names = ['saved-seeds.json', 'catalogue.db'].filter(name => fs.existsSync(path.join(from, name)));
  if (!names.length) return dialog.showMessageBox(window, { type: 'warning', message: 'Nothing to import', detail: 'That folder has no saved-seeds.json or catalogue.db. Choose a Seed Scout folder, or the data folder of another install.' });
  if (path.resolve(from) === path.resolve(dataDir())) return;
  const { response } = await dialog.showMessageBox(window, {
    type: 'question', buttons: ['Import', 'Cancel'], defaultId: 0, cancelId: 1, message: `Import ${names.join(' and ')}?`,
    detail: 'This replaces the saved seeds and catalogue in this app. The current ones are kept beside them with ".bak" added to their names.',
  });
  if (response !== 0) return;
  // The backend holds the catalogue open, so it is stopped for the copy and started again afterwards.
  const child = backend, minecraft = settings().minecraft || defaultMinecraft();
  if (child) await new Promise(done => { child.once('exit', done); setTimeout(done, 5000); stopBackend(); });
  window.loadFile(path.join(__dirname, 'loading.html'));
  try {
    for (const name of names) {
      const target = path.join(dataDir(), name);
      if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak`);
      fs.copyFileSync(path.join(from, name), target);
    }
  } catch (error) { dialog.showMessageBox(window, { type: 'error', message: 'Import failed', detail: String(error.message || error) }); }
  startBackend(minecraft);
}

// What changed in a version: the notes the release workflow wrote from the commits that went into it.
async function showReleaseNotes(version = app.getVersion()) {
  const page = `https://github.com/${REPOSITORY}/releases/tag/v${version}`;
  let notes = '';
  try {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/tags/v${version}`, { headers: { 'User-Agent': 'seed-scout', Accept: 'application/vnd.github+json' } });
    if (response.ok) notes = String((await response.json()).body || '').trim();
  } catch { }
  const { response } = await dialog.showMessageBox(window, {
    type: 'info', buttons: ['OK', 'Open on GitHub'], defaultId: 0, cancelId: 0, message: `What's new in Seed Scout ${version}`,
    detail: notes ? (notes.length > 1500 ? `${notes.slice(0, 1500)}…` : notes) : 'The notes for this version could not be loaded. They are on its GitHub release page.',
  });
  if (response === 1) shell.openExternal(page);
}
async function showAbout() {
  let minecraft = '';
  try { minecraft = (await (await fetch(`${backendUrl}/api/versions`)).json()).current; } catch { }
  const update = updateReady ? `Version ${updateAvailable} is downloaded and installs on restart.` : updateAvailable ? `Version ${updateAvailable} is available (Help → Update).`
    : settings().updates === 'manual' ? 'Automatic update prompts are off; check from the Help menu.' : 'No newer version was found at the last check.';
  const { response } = await dialog.showMessageBox(window, {
    type: 'info', buttons: ['OK', "What's new", 'GitHub'], defaultId: 0, cancelId: 0, message: `Seed Scout version ${app.getVersion()}`,
    detail: `Finds Minecraft seeds by the structures and biomes near spawn, with a terrain map.\n\n` +
      `App version: ${app.getVersion()}\n${update}\n\n` +
      `Minecraft version in use: ${minecraft || 'not started yet'}\nRead from: ${settings().minecraft || defaultMinecraft()}\n\n` +
      `Open source under the MIT licence. Not affiliated with Mojang or Microsoft; Minecraft is not included.`,
  });
  if (response === 1) showReleaseNotes();
  if (response === 2) shell.openExternal(`https://github.com/${REPOSITORY}`);
}

// ---- Updates: the release workflow publishes each version to GitHub Releases, where the updater looks. ----
// A new version is offered with a yes or no. "No" is remembered across restarts: nothing is offered again until
// the user checks from the Help menu and says yes, which turns the offers back on.
function setupUpdates() {
  if (!packaged) return null;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.logger = { info: m => log(`[update] ${m}`), warn: m => log(`[update] ${m}`), error: m => log(`[update] ${m}`), debug() { } };
  autoUpdater.autoDownload = false; autoUpdater.autoInstallOnAppQuit = true;
  let asked = false, offering = false, downloading = false;
  async function offer(info) {
    if (offering || downloading || updateReady) return;
    offering = true;
    const { response } = await dialog.showMessageBox(window, {
      type: 'question', buttons: ['Yes', 'No'], defaultId: 0, cancelId: 1, message: `Update Seed Scout to ${info.version}?`,
      detail: `You have version ${app.getVersion()}. The update downloads now and installs when the app restarts.\n\n` +
        'If you choose No, Seed Scout will not ask again. You can still update at any time from Help → Check for updates.',
    });
    offering = false;
    if (response !== 0) return saveSettings({ updates: 'manual' });
    saveSettings({ updates: 'ask' }); downloading = true;
    if (Notification.isSupported()) new Notification({ title: 'Seed Scout update', body: `Version ${info.version} is downloading.` }).show();
    autoUpdater.downloadUpdate().catch(error => { downloading = false; dialog.showMessageBox(window, { type: 'warning', message: 'The update could not be downloaded', detail: String(error?.message || error).slice(0, 600) }); });
  }
  autoUpdater.on('update-available', info => {
    const byUser = asked; asked = false;
    updateAvailable = info.version; buildMenu();
    if (byUser || settings().updates !== 'manual') offer(info);
  });
  autoUpdater.on('update-not-available', () => { if (asked) dialog.showMessageBox(window, { message: 'Seed Scout is up to date', detail: `Version ${app.getVersion()}` }); asked = false; });
  autoUpdater.on('error', error => { if (asked) dialog.showMessageBox(window, { type: 'warning', message: 'Could not check for updates', detail: String(error?.message || error).slice(0, 600) }); asked = false; });
  autoUpdater.on('update-downloaded', async info => {
    updateReady = true; downloading = false; updateAvailable = info.version; buildMenu();
    const { response } = await dialog.showMessageBox(window, {
      type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
      message: `Seed Scout ${info.version} is ready`, detail: 'Restart to finish updating. Otherwise it installs the next time you close the app.',
    });
    if (response === 0) installUpdate();
  });
  const check = byUser => { asked = byUser; autoUpdater.checkForUpdates().catch(() => { }); };
  check(false); setInterval(() => check(false), UPDATE_INTERVAL);
  return { check: () => check(true), install: () => autoUpdater.quitAndInstall() };
}
let updates = null;
function installUpdate() { quitting = true; stopBackend(); setTimeout(() => updates.install(), 1800); }

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Minecraft folder…', click: changeMinecraft },
      { label: 'Import saved seeds and catalogue…', click: importData },
      { label: 'Open data folder', click: () => shell.openPath(dataDir()) },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Help', submenu: [
      { label: "What's new", click: () => showReleaseNotes() },
      { type: 'separator' },
      updateReady ? { label: `Restart to update to ${updateAvailable}`, click: installUpdate }
        : { label: updateAvailable ? `Update to ${updateAvailable}…` : 'Check for updates…', enabled: !!updates, click: () => updates.check() },
      { label: `About Seed Scout ${app.getVersion()}`, click: showAbout },
    ] },
  ]));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.defamationstation.seedscout');
    fs.mkdirSync(dataDir(), { recursive: true });
    logStream = fs.createWriteStream(path.join(app.getPath('userData'), 'desktop.log'), { flags: 'w' });
    window = new BrowserWindow({ width: 1440, height: 900, minWidth: 900, minHeight: 600, backgroundColor: '#0b1012', autoHideMenuBar: true, title: 'Seed Scout', webPreferences: { contextIsolation: true, sandbox: true } });
    window.on('closed', () => { window = null; });
    // Only the local app is shown in the window; any other link opens in the user's browser.
    window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, url) => { if (backendUrl && !url.startsWith(backendUrl)) { event.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
    buildMenu();
    await window.loadFile(path.join(__dirname, 'loading.html'));
    const folder = await minecraftFolder();
    if (!folder) return app.quit();
    startBackend(folder);
    updates = setupUpdates(); buildMenu();
    // The first start of a new version says what changed.
    const previous = settings().version;
    if (previous !== app.getVersion()) { saveSettings({ version: app.getVersion() }); if (previous && packaged) showReleaseNotes(); }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { quitting = true; stopBackend(); });
}
