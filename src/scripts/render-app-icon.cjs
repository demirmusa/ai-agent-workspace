// Run from src: node_modules/electron/dist/electron.exe scripts/render-app-icon.cjs
// The SVG is the artwork source; commit the rendered PNGs for the desktop app.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

app.whenReady().then(async () => {
  const directory = join(__dirname, '../control-ui/icons');
  const svg = readFileSync(join(directory, 'aiws.svg'), 'utf8');
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;background:transparent"></body>'));
    for (const size of [32, 256]) {
      const png = await window.webContents.executeJavaScript(`(async () => {
        const image = new Image();
        image.src = ${JSON.stringify('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg))};
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = ${size};
        canvas.getContext('2d').drawImage(image, 0, 0, ${size}, ${size});
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      writeFileSync(join(directory, `aiws-${size}.png`), Buffer.from(png, 'base64'));
    }
  } finally {
    window.destroy();
  }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
