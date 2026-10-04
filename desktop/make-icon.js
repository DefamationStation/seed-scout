// Renders build/icon.svg to build/icon.png, which the installer build turns into the Windows icon.
// Run with: npx electron make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, 'build', 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;overflow:hidden;background:transparent">${svg}</body>`));
  await new Promise(done => setTimeout(done, 400));
  const image = (await win.webContents.capturePage()).resize({ width: 512, height: 512, quality: 'best' });
  fs.writeFileSync(path.join(__dirname, 'build', 'icon.png'), image.toPNG());
  app.quit();
});
