const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { startBridge, resolveClaudeBinary } = require('./bridge/server-lib');

let win;
let bridgeServer;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    title: 'DeepBook Studio',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'DeepBook_Studio_v4_4.html'));

  // Any target="_blank" / window.open goes to the real browser, not a new
  // Electron window — keeps the app single-window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ── Sign-in flow ────────────────────────────────────────────────────────
// `claude login` prints an authorization URL and waits for the browser flow
// to complete. We spawn it, watch stdout/stderr for the first URL, open it
// for the user automatically, and resolve once the process exits (or after
// a generous timeout so the app never hangs forever).
ipcMain.handle('deepbook:signin', async () => {
  let bin;
  try { bin = resolveClaudeBinary(); } catch (e) { return { ok: false, message: e.message }; }

  return new Promise((resolve) => {
    let opened = false;
    let settled = false;
    const urlPattern = /https?:\/\/\S+/;

    const child = spawn(bin, ['login'], { stdio: ['ignore', 'pipe', 'pipe'] });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const watch = (buf) => {
      const text = buf.toString();
      const match = text.match(urlPattern);
      if (match && !opened) {
        opened = true;
        shell.openExternal(match[0]);
      }
    };

    child.stdout.on('data', watch);
    child.stderr.on('data', watch);

    child.on('error', (e) => finish({ ok: false, message: e.message }));
    child.on('close', (code) => {
      finish({
        ok: code === 0,
        message: code === 0
          ? 'Signed in.'
          : (opened
            ? 'Finish signing in in the browser tab that opened, then click Test Connection.'
            : 'Could not detect a sign-in link automatically. Check your default browser, or run `claude login` from a terminal using the bundled binary at: ' + bin),
      });
    });

    // Don't hang forever if the user never completes the browser flow —
    // the child process itself stays alive waiting, so surface a status
    // message after a while rather than blocking the Settings UI.
    const timer = setTimeout(() => {
      finish({ ok: opened, message: opened ? 'Still waiting on the browser sign-in — finish it there, then click Test Connection.' : 'Sign-in is taking a while — check your default browser, or click Test Connection once you\'ve signed in.' });
    }, 20000);
  });
});
// ─────────────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  try {
    bridgeServer = await startBridge();
  } catch (e) {
    console.error('Bridge server failed to start:', e);
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (bridgeServer) bridgeServer.close();
  if (process.platform !== 'darwin') app.quit();
});
