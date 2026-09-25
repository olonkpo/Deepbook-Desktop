const { contextBridge, ipcRenderer } = require('electron');

// Minimal, safe surface exposed to the page — just enough to trigger the
// one-time sign-in flow. The page still talks to the bridge purely over
// http://127.0.0.1:8787 like it would with the standalone bridge server, so
// this file is the only thing that differs between "app in a browser tab +
// standalone bridge.js" and "app inside this Electron shell".
contextBridge.exposeInMainWorld('deepbook', {
  startSignIn: () => ipcRenderer.invoke('deepbook:signin-start'),
  submitSignInCode: (code) => ipcRenderer.invoke('deepbook:signin-submit-code', code),
  isElectron: true,
  checkForUpdates: () => ipcRenderer.invoke('deepbook:check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('deepbook:download-update'),
  installUpdate: () => ipcRenderer.invoke('deepbook:install-update'),
  getAppVersion: () => ipcRenderer.invoke('deepbook:get-app-version'),
  onUpdateStatus: (cb) => {
    const handler = (_event, status) => cb(status);
    ipcRenderer.on('deepbook:update-status', handler);
    return () => ipcRenderer.removeListener('deepbook:update-status', handler);
  },
  openLogsFolder: () => ipcRenderer.invoke('deepbook:open-logs-folder'),
  getRecentLogs: (maxLines) => ipcRenderer.invoke('deepbook:get-recent-logs', maxLines),
  reportIssue: () => ipcRenderer.invoke('deepbook:report-issue'),
});
