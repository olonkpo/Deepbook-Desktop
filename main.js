const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const { startBridge, resolveClaudeBinary } = require('./bridge/server-lib');

let win;
let bridgeServer;

// Forward update lifecycle events to whichever renderer window is open, so
// the Settings panel can show live status text.
function sendUpdateStatus(status) {
  if (win && !win.isDestroyed()) win.webContents.send('deepbook:update-status', status);
}

autoUpdater.autoDownload = false;      // we drive download explicitly from the button
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('checking-for-update', () => sendUpdateStatus({ state: 'checking' }));
autoUpdater.on('update-available', (info) => sendUpdateStatus({ state: 'available', version: info.version }));
autoUpdater.on('update-not-available', () => sendUpdateStatus({ state: 'up-to-date' }));
autoUpdater.on('download-progress', (p) => sendUpdateStatus({ state: 'downloading', percent: Math.round(p.percent) }));
autoUpdater.on('update-downloaded', (info) => sendUpdateStatus({ state: 'downloaded', version: info.version }));
autoUpdater.on('error', (err) => sendUpdateStatus({ state: 'error', message: err?.message || String(err) }));

ipcMain.handle('deepbook:check-for-updates', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, updateInfo: result?.updateInfo };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle('deepbook:download-update', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle('deepbook:install-update', () => {
  autoUpdater.quitAndInstall();
});

ipcMain.handle('deepbook:get-app-version', () => app.getVersion());

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
// `claude auth login` opens a browser for OAuth consent, then the browser
// page shows a short code you paste back into the CLI to finish. We drive
// this in two steps so the Settings UI can show its own "paste code" box
// instead of needing a real terminal:
//   1) deepbook:signin-start   — spawn the command, auto-open the URL it
//                                 prints, resolve once it's ready for a code
//   2) deepbook:signin-submit-code — write the pasted code to its stdin,
//                                 resolve once the process finishes
let signinChild = null;

ipcMain.handle('deepbook:signin-start', async () => {
  let bin;
  try { bin = resolveClaudeBinary(); } catch (e) { return { ok: false, message: e.message }; }

  if (signinChild) { try { signinChild.kill(); } catch {} signinChild = null; }

  return new Promise((resolve) => {
    let settled = false;
    let opened = false;
    let buffered = '';
    const urlPattern = /https?:\/\/\S+/;

    const child = spawn(bin, ['auth', 'login'], { stdio: ['pipe', 'pipe', 'pipe'] });
    signinChild = child;

    const finishOnce = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const onData = (buf) => {
      const text = buf.toString();
      buffered += text;

      const urlMatch = buffered.match(urlPattern);
      if (urlMatch && !opened) {
        opened = true;
        shell.openExternal(urlMatch[0]);
      }

      // Once it's ready to accept the pasted code, hand control back to the
      // renderer instead of waiting for the whole process to exit.
      if (/paste code/i.test(buffered)) {
        finishOnce({ ok: true, needsCode: true, message: 'Paste the code shown on the page you just approved.' });
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (e) => { signinChild = null; finishOnce({ ok: false, message: e.message }); });
    child.on('close', (code) => {
      signinChild = null;
      // If it exited before ever asking for a code, report whatever we saw.
      finishOnce({
        ok: code === 0,
        needsCode: false,
        message: code === 0 ? 'Signed in.' : (buffered.trim() || `claude auth login exited with code ${code}`),
      });
    });

    const timer = setTimeout(() => {
      finishOnce({ ok: opened, needsCode: false, message: opened ? 'Still waiting — finish signing in in your browser.' : 'Could not detect a sign-in link. Check your default browser or try again.' });
    }, 20000);
  });
});

ipcMain.handle('deepbook:signin-submit-code', async (_event, code) => {
  if (!signinChild) return { ok: false, message: 'No sign-in in progress — click Sign in to Claude again.' };

  return new Promise((resolve) => {
    let settled = false;
    let buffered = '';
    const finishOnce = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };

    const onData = (buf) => { buffered += buf.toString(); };
    signinChild.stdout.on('data', onData);
    signinChild.stderr.on('data', onData);

    signinChild.on('close', (exitCode) => {
      signinChild = null;
      finishOnce({ ok: exitCode === 0, message: exitCode === 0 ? 'Signed in.' : (buffered.trim() || `Exited with code ${exitCode}`) });
    });
    signinChild.on('error', (e) => { signinChild = null; finishOnce({ ok: false, message: e.message }); });

    signinChild.stdin.write(String(code).trim() + '\n');

    const timer = setTimeout(() => finishOnce({ ok: false, message: 'Timed out waiting to confirm sign-in — try Test Connection.' }), 20000);
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
