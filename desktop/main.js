// Desktop shell: starts the local Seed Scout backend, shows its page in a window, and keeps the app up to date.
const { app, BrowserWindow, Menu, Notification, dialog, shell } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// The engine is written against this version's world-generation classes.
const SUPPORTED_VERSION = '26.4-snapshot-2';
const UPDATE_INTERVAL = 4 * 60 * 60 * 1000;

let window = null, backend = null, backendUrl = '', quitting = false, logStream = null, updateReady = false;

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
const hasVersion = folder => ['jar', 'json'].every(ext => fs.existsSync(path.join(folder, 'versions', SUPPORTED_VERSION, `${SUPPORTED_VERSION}.${ext}`)));

// The Minecraft folder to read: the saved choice, else the launcher's default. Asks when the version is not there.
async function minecraftFolder(forceAsk = false) {
  let folder = settings().minecraft || defaultMinecraft();
  while (forceAsk || !hasVersion(folder)) {
    const { response } = await dialog.showMessageBox(window, {
      type: forceAsk ? 'question' : 'warning', buttons: ['Choose Minecraft folder…', forceAsk ? 'Cancel' : 'Quit'], defaultId: 0, cancelId: 1,
      message: forceAsk ? 'Choose your Minecraft folder' : `Minecraft ${SUPPORTED_VERSION} was not found`,
      detail: `Seed Scout reads the game's own world generation from your install and needs version ${SUPPORTED_VERSION}.\n\n` +
        `Current folder: ${folder}\n\nInstall that version in the Minecraft Launcher (run it once so its files download), or choose the folder that contains "versions" and "libraries".`,
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
  const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', SEED_SCOUT_DATA: dataDir(), SEED_SCOUT_MINECRAFT: minecraft, SEED_SCOUT_VERSION: SUPPORTED_VERSION };
  if (jdk) env.SEED_SCOUT_JDK = jdk;
  // Port 0 lets the system pick a free port; the backend prints the address it ended up on.
  const child = backend = spawn(python, [path.join(appRoot, 'app.py'), '--port', '0', '--no-browser'], { cwd: dataDir(), env, windowsHide: true });
  let tail = '';
  const read = chunk => {
    const text = chunk.toString(); log(text); tail = (tail + text).slice(-4000);
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
    dialog.showMessageBoxSync(window, { type: 'error', message: 'Seed Scout could not start its engine', detail: tail.trim().split('\n').slice(-12).join('\n') || `The backend stopped (code ${code}).`, buttons: ['Quit'] });
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

// ---- Updates: the release workflow publishes each version to GitHub Releases, where the updater looks. ----
function setupUpdates() {
  if (!packaged) return null;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.logger = { info: m => log(`[update] ${m}`), warn: m => log(`[update] ${m}`), error: m => log(`[update] ${m}`), debug() { } };
  autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true;
  let asked = false;
  autoUpdater.on('update-available', info => {
    if (Notification.isSupported()) new Notification({ title: 'Seed Scout update', body: `Version ${info.version} is available and is downloading.` }).show();
  });
  autoUpdater.on('update-not-available', () => { if (asked) dialog.showMessageBox(window, { message: 'Seed Scout is up to date', detail: `Version ${app.getVersion()}` }); asked = false; });
  autoUpdater.on('error', error => { if (asked) dialog.showMessageBox(window, { type: 'warning', message: 'Could not check for updates', detail: String(error?.message || error).slice(0, 600) }); asked = false; });
  autoUpdater.on('update-downloaded', async info => {
    updateReady = true; asked = false; buildMenu();
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
      { label: 'Open data folder', click: () => shell.openPath(dataDir()) },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Help', submenu: [
      updateReady ? { label: 'Restart to update', click: installUpdate } : { label: 'Check for updates…', enabled: !!updates, click: () => updates.check() },
      { label: `Version ${app.getVersion()}`, enabled: false },
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
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { quitting = true; stopBackend(); });
}
