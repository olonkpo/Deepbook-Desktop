const { contextBridge, ipcRenderer } = require('electron');

// Minimal, safe surface exposed to the page — just enough to trigger the
// one-time sign-in flow. The page still talks to the bridge purely over
// http://127.0.0.1:8787 like it would with the standalone bridge server, so
// this file is the only thing that differs between "app in a browser tab +
// standalone bridge.js" and "app inside this Electron shell".
contextBridge.exposeInMainWorld('deepbook', {
  signIn: () => ipcRenderer.invoke('deepbook:signin'),
  isElectron: true,
});
