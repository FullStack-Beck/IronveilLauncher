// preload.js — context-bridge between renderer and main process
// All channels are explicitly allowlisted; no raw ipcRenderer exposure.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {

  // ── Window controls ────────────────────────────────────────
  minimize: ()      => ipcRenderer.send('window:minimize'),
  maximize: ()      => ipcRenderer.send('window:maximize'),
  close:    ()      => ipcRenderer.send('window:close'),

  // ── Shell ──────────────────────────────────────────────────
  openExternal: (url) => ipcRenderer.send('shell:open', url),

  // ── Persistent store ───────────────────────────────────────
  storeGet: (key)         => ipcRenderer.invoke('store:get', key),
  storeSet: (key, value)  => ipcRenderer.invoke('store:set', key, value),

  // ── Game detection / launch ────────────────────────────────
  detectGame:  (path)     => ipcRenderer.invoke('game:detect', path),
  launchGame:  (path)     => ipcRenderer.invoke('game:launch', path),
  browseGame:  ()         => ipcRenderer.invoke('game:browse'),

  // ── Installation info ──────────────────────────────────────
  // Returns: { installed, installedVer, installDir, exePath }
  installInfo: ()         => ipcRenderer.invoke('game:installInfo'),

  // ── Release listing ────────────────────────────────────────
  // { owner, repo, token } → { success, releases[] }
  listReleases: (opts)    => ipcRenderer.invoke('releases:list', opts),

  // ── Update check ───────────────────────────────────────────
  // { owner, repo, token } → { success, upToDate, installedVersion, latestVersion, latestRelease }
  checkUpdate: (opts)     => ipcRenderer.invoke('game:checkUpdate', opts),

  // ── Install / update ───────────────────────────────────────
  // { owner, repo, token, assetId, assetName, version, installDir? }
  // Progress/status streamed via onInstallProgress / onInstallStatus / onInstallDone
  installGame: (opts)     => ipcRenderer.invoke('game:install', opts),

  // ── Uninstall ──────────────────────────────────────────────
  uninstallGame: ()       => ipcRenderer.invoke('game:uninstall'),

  // ── Install event listeners ────────────────────────────────
  // Renderer registers callbacks; main pushes progress during download.
  onInstallProgress: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('install:progress', handler);
    return () => ipcRenderer.removeListener('install:progress', handler);
  },

  onInstallStatus: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('install:status', handler);
    return () => ipcRenderer.removeListener('install:status', handler);
  },

  onInstallDone: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('install:done', handler);
    return () => ipcRenderer.removeListener('install:done', handler);
  },

});
