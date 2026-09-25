const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const { startBridge, resolveClaudeBinary } = require('./bridge/server-lib');

// Captures console.log/warn/error from main AND renderer into a real log
// file on disk, and gives us a stack trace for crashes we'd otherwise never
// see (packaged apps have no visible terminal).
log.initialize();
autoUpdater.logger = log;
process.on('uncaughtException', (err) => log.error('uncaughtException:', err));
process.on('unhandledRejection', (reason) => log.error('unhandledRejection:', reason));

function getLogFilePath() {
  try { return log.transports.file.getFile().path; } catch { return null; }
}

ipcMain.handle('deepbook:open-logs-folder', () => {
  const file = getLogFilePath();
  if (file) shell.showItemInFolder(file);
  return { ok: !!file };
});

ipcMain.handle('deepbook:get-recent-logs', (_event, maxLines = 200) => {
  const file = getLogFilePath();
  if (!file) return '';
  try {
    return fs.readFileSync(file, 'utf8').split('\n').slice(-maxLines).join('\n');
  } catch {
    return '';
  }
});

ipcMain.handle('deepbook:report-issue', () => {
  try {
    const version = app.getVersion();
    const platform = `${process.platform}-${process.arch}`;
    const file = getLogFilePath();
    let logs = '';
    try { logs = fs.readFileSync(file, 'utf8').split('\n').slice(-60).join('\n').slice(-3000); } catch {}
    const body = [
      `**App version:** ${version}`,
      `**Platform:** ${platform}`,
      '',
      '**What happened:**',
      '<!-- describe the problem here -->',
      '',
      '<details><summary>Recent logs</summary>',
      '',
      '```',
      logs || '(no logs captured yet)',
      '```',
      '</details>',
    ].join('\n');
    const url = 'https://github.com/olonkpo/Deepbook-Desktop/issues/new?' +
      new URLSearchParams({ title: `Issue in v${version}`, body }).toString();
    shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

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
// GitHub's releases endpoint intermittently answers electron-updater's feed
// request with a transient 406 that succeeds again seconds later — a known,
// documented flake, not a real problem with the release. So don't push
// every raw 'error' straight to the UI; the retry wrapper below decides
// whether it's worth showing the user anything.
autoUpdater.on('error', (err) => console.error('autoUpdater error (may be transient):', err?.message || err));

async function checkForUpdatesWithRetry(retriesLeft = 1) {
  try {
    return await autoUpdater.checkForUpdates();
  } catch (e) {
    if (retriesLeft > 0) {
      await new Promise((r) => setTimeout(r, 2000));
      return checkForUpdatesWithRetry(retriesLeft - 1);
    }
    throw e;
  }
}

ipcMain.handle('deepbook:check-for-updates', async () => {
  try {
    const result = await checkForUpdatesWithRetry(1);
    return { ok: true, updateInfo: result?.updateInfo };
  } catch (e) {
    sendUpdateStatus({ state: 'error', message: e.message });
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
  try { bin = resolveClaudeBinary(); } catch (e) { return { ok: false, message: 'Could not locate the bundled Claude binary: ' + e.message }; }

  if (signinChild) { try { signinChild.kill(); } catch {} signinChild = null; }

  try {
    return await new Promise((resolve) => {
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

    child.on('error', (e) => { signinChild = null; finishOnce({ ok: false, message: 'Could not start claude auth login: ' + e.message }); });
    child.on('close', (code) => {
      signinChild = null;
      // If it exited before ever asking for a code, report whatever we saw.
      finishOnce({
        ok: code === 0,
        needsCode: false,
        message: code === 0 ? 'Signed in.' : (buffered.trim() ? `claude auth login exited (code ${code}): ${buffered.trim().slice(-500)}` : `claude auth login exited with code ${code} and no output`),
      });
    });

    const timer = setTimeout(() => {
      finishOnce({
        ok: opened,
        needsCode: false,
        message: opened
          ? 'Still waiting — finish signing in in your browser.'
          : `No sign-in link detected after 20s. CLI output so far: ${buffered.trim() ? buffered.trim().slice(-500) : '(nothing printed at all)'}`,
      });
    }, 20000);
    });
  } catch (e) {
    return { ok: false, message: 'Unexpected error starting sign-in: ' + (e?.message || String(e)) };
  }
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
