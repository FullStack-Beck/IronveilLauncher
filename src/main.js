const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { exec, spawn } = require('child_process');
const fs   = require('fs');
const https = require('https');
const os   = require('os');

let mainWindow;
let gameProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 860,
    minHeight: 580,
    frame: false,
    transparent: false,
    backgroundColor: '#f0e6cc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '../assets/icon.png'),
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (gameProcess) gameProcess.kill();
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── Window controls ──────────────────────────────────────────
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

// ── Shell ────────────────────────────────────────────────────
ipcMain.on('shell:open', (_, url) => shell.openExternal(url));

// ── Persistent store ─────────────────────────────────────────
const storePath = path.join(app.getPath('userData'), 'ironveil-config.json');

ipcMain.handle('store:get', async (_, key) => {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    return JSON.parse(raw)[key] ?? null;
  } catch { return null; }
});

ipcMain.handle('store:set', async (_, key, value) => {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch {}
  data[key] = value;
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2));
  return true;
});

// ── Helpers ──────────────────────────────────────────────────
const getStore = (key) => {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    return JSON.parse(raw)[key] ?? null;
  } catch { return null; }
};

const setStore = (key, value) => {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch {}
  data[key] = value;
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2));
};

// ── Game directories ─────────────────────────────────────────
function getDefaultInstallDir() {
  const platform = process.platform;
  if (platform === 'win32') {
    return path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Ironveil');
  } else if (platform === 'darwin') {
    return path.join(app.getPath('home'), 'Applications', 'Ironveil');
  }
  return path.join(app.getPath('home'), 'Ironveil');
}

function getGameExecutable(installDir) {
  if (process.platform === 'win32') {
    return path.join(installDir, 'ProjectIronveil.exe');
  } else if (process.platform === 'darwin') {
    return path.join(installDir, 'ProjectIronveil.app');
  }
  return path.join(installDir, 'ProjectIronveil');
}

// ── Game detection ───────────────────────────────────────────
ipcMain.handle('game:detect', async (_, gamePath) => {
  // Check stored install path first
  const storedDir = getStore('game_install_dir');
  const checkPath = gamePath || (storedDir ? getGameExecutable(storedDir) : null);

  if (checkPath && fs.existsSync(checkPath)) {
    return { found: true, path: checkPath };
  }

  // Auto-scan common locations
  const candidates = [
    ...(storedDir ? [getGameExecutable(storedDir)] : []),
    getGameExecutable(getDefaultInstallDir()),
    // Legacy paths for manually installed copies
    'C:\\Program Files\\ProjectIronveil\\ProjectIronveil.exe',
    'C:\\Program Files (x86)\\ProjectIronveil\\ProjectIronveil.exe',
    path.join(process.env.USERPROFILE || '', 'Desktop', 'ProjectIronveil.exe'),
    '/Applications/ProjectIronveil.app',
    path.join(process.env.HOME || '', 'Desktop', 'ProjectIronveil.app'),
  ];

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return { found: true, path: c };
  }
  return { found: false, path: null };
});

// ── Game launch ──────────────────────────────────────────────
ipcMain.handle('game:launch', async (_, gamePath) => {
  if (!gamePath || !fs.existsSync(gamePath)) {
    return { success: false, error: 'Game executable not found.' };
  }
  try {
    if (process.platform === 'darwin') {
      gameProcess = spawn('open', [gamePath]);
    } else {
      gameProcess = spawn(gamePath, [], { detached: true, stdio: 'ignore' });
      gameProcess.unref();
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ── Browse for game ──────────────────────────────────────────
ipcMain.handle('game:browse', async () => {
  const { dialog } = require('electron');
  const filters = process.platform === 'darwin'
    ? [{ name: 'Application', extensions: ['app'] }]
    : [{ name: 'Executable', extensions: ['exe'] }];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Locate Project Ironveil',
    properties: ['openFile'],
    filters,
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ═══════════════════════════════════════════════════════════════
// GAME INSTALLATION SYSTEM
// Fetches releases from a private GitHub repo using a token
// supplied by the renderer (loaded from Supabase, never hardcoded).
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch JSON from GitHub API with the supplied token.
 */
function githubGet(url, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'IronveilLauncher/1.0',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };
    https.get(url, opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from GitHub API')); }
      });
    }).on('error', reject);
  });
}

/**
 * Fetch list of releases from the private repo.
 * Returns: [{ id, tag_name, name, published_at, assets: [{ id, name, size }] }]
 */
ipcMain.handle('releases:list', async (_, { owner, repo, token }) => {
  try {
    const releases = await githubGet(
      `https://api.github.com/repos/${owner}/${repo}/releases`,
      token
    );
    if (!Array.isArray(releases)) {
      return { success: false, error: releases.message || 'Unknown error from GitHub' };
    }
    // Return a safe subset (no sensitive fields)
    return {
      success: true,
      releases: releases.map(r => ({
        id:           r.id,
        tag_name:     r.tag_name,
        name:         r.name,
        body:         r.body,
        published_at: r.published_at,
        assets: (r.assets || []).map(a => ({
          id:   a.id,
          name: a.name,
          size: a.size,
        }))
      }))
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Check installed version against latest release.
 * Returns: { upToDate, installedVersion, latestVersion, latestRelease }
 */
ipcMain.handle('game:checkUpdate', async (_, { owner, repo, token }) => {
  const installedVersion = getStore('installed_version') || null;

  try {
    const latest = await githubGet(
      `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
      token
    );
    if (latest.message) {
      return { success: false, error: latest.message };
    }
    return {
      success: true,
      upToDate: installedVersion === latest.tag_name,
      installedVersion,
      latestVersion: latest.tag_name,
      latestRelease: {
        id:           latest.id,
        tag_name:     latest.tag_name,
        name:         latest.name,
        body:         latest.body,
        published_at: latest.published_at,
        assets: (latest.assets || []).map(a => ({ id: a.id, name: a.name, size: a.size }))
      }
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Download a private GitHub release asset and install it.
 *
 * Flow:
 *  1. Fetch the asset redirect URL from GitHub API (auth required).
 *  2. Download the binary to a temp file, emitting progress events.
 *  3. Run the installer (Windows: .exe setup; macOS: mount .dmg and copy .app).
 *  4. Store the installed version tag in the config.
 *
 * Progress events sent to renderer:
 *   'install:progress' { percent, bytesReceived, totalBytes }
 *   'install:status'   { message }
 *   'install:done'     { success, error? }
 */
ipcMain.handle('game:install', async (_, { owner, repo, token, assetId, assetName, version, installDir }) => {
  const targetDir = installDir || getDefaultInstallDir();

  // Ensure install directory exists
  fs.mkdirSync(targetDir, { recursive: true });

  const tmpFile = path.join(os.tmpdir(), assetName);

  const send = (channel, payload) => {
    mainWindow?.webContents.send(channel, payload);
  };

  return new Promise((resolve) => {

    // ── Step 1: Get asset redirect URL ──────────────────────
    send('install:status', { message: 'Contacting forge servers…' });

    const reqOptions = {
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/releases/assets/${assetId}`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/octet-stream',
        'User-Agent': 'IronveilLauncher/1.0',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };

    const doDownload = (downloadUrl) => {
      send('install:status', { message: 'Downloading build…' });

      const file = fs.createWriteStream(tmpFile);
      let bytesReceived = 0;
      let totalBytes = 0;

      const request = https.get(downloadUrl, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'IronveilLauncher/1.0'
        }
      }, (res) => {
        // Handle redirect (GitHub asset downloads redirect to S3)
        if (res.statusCode === 302 || res.statusCode === 301) {
          file.close();
          doDownload(res.headers.location);
          return;
        }

        totalBytes = parseInt(res.headers['content-length'] || '0', 10);

        res.on('data', (chunk) => {
          bytesReceived += chunk.length;
          const percent = totalBytes ? Math.round((bytesReceived / totalBytes) * 100) : 0;
          send('install:progress', { percent, bytesReceived, totalBytes });
        });

        res.pipe(file);

        file.on('finish', () => {
          file.close(async () => {
            send('install:status', { message: 'Installing…' });
            try {
              await runInstaller(tmpFile, assetName, targetDir, send);
              setStore('installed_version', version);
              setStore('game_install_dir', targetDir);
              send('install:done', { success: true });
              resolve({ success: true });
            } catch (err) {
              send('install:done', { success: false, error: err.message });
              resolve({ success: false, error: err.message });
            } finally {
              // Clean up tmp file
              try { fs.unlinkSync(tmpFile); } catch {}
            }
          });
        });

        file.on('error', (err) => {
          file.close();
          try { fs.unlinkSync(tmpFile); } catch {}
          send('install:done', { success: false, error: err.message });
          resolve({ success: false, error: err.message });
        });
      });

      request.on('error', (err) => {
        send('install:done', { success: false, error: err.message });
        resolve({ success: false, error: err.message });
      });
    };

    // First request to get the redirect to the actual asset
    const firstReq = https.get(`https://api.github.com${reqOptions.path}`, reqOptions, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        doDownload(res.headers.location);
      } else {
        // Shouldn't normally happen, but try to pipe directly
        doDownload(`https://api.github.com${reqOptions.path}`);
      }
    });

    firstReq.on('error', (err) => {
      send('install:done', { success: false, error: err.message });
      resolve({ success: false, error: err.message });
    });
  });
});

/**
 * Run the platform-appropriate installer.
 */
async function runInstaller(filePath, assetName, targetDir, send) {
  const ext = path.extname(assetName).toLowerCase();
  const platform = process.platform;

  if (platform === 'win32') {
    if (ext === '.exe') {
      // NSIS / Inno Setup installer
      send('install:status', { message: 'Running Windows installer…' });
      await runCommand(`"${filePath}" /S /D="${targetDir}"`);
    } else if (ext === '.zip') {
      send('install:status', { message: 'Extracting build…' });
      await runCommand(`powershell -Command "Expand-Archive -Force -Path '${filePath}' -DestinationPath '${targetDir}'"`);
    }
  } else if (platform === 'darwin') {
    if (ext === '.dmg') {
      // Mount DMG, copy .app, unmount
      send('install:status', { message: 'Mounting disk image…' });
      const mountPoint = `/Volumes/Ironveil_${Date.now()}`;
      await runCommand(`hdiutil attach "${filePath}" -mountpoint "${mountPoint}" -quiet`);
      send('install:status', { message: 'Copying game to Applications…' });
      const appFiles = fs.readdirSync(mountPoint).filter(f => f.endsWith('.app'));
      if (!appFiles.length) throw new Error('No .app found inside DMG');
      fs.mkdirSync(targetDir, { recursive: true });
      await runCommand(`cp -R "${path.join(mountPoint, appFiles[0])}" "${targetDir}/"`);
      await runCommand(`hdiutil detach "${mountPoint}" -quiet`);
    } else if (ext === '.zip') {
      send('install:status', { message: 'Extracting build…' });
      fs.mkdirSync(targetDir, { recursive: true });
      await runCommand(`unzip -o "${filePath}" -d "${targetDir}"`);
    }
  }
}

function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Uninstall: remove the game directory and clear stored version.
 */
ipcMain.handle('game:uninstall', async () => {
  const installDir = getStore('game_install_dir');
  if (!installDir || !fs.existsSync(installDir)) {
    return { success: false, error: 'No installed game found.' };
  }
  try {
    fs.rmSync(installDir, { recursive: true, force: true });
    setStore('installed_version', null);
    setStore('game_install_dir', null);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Get current installation info.
 */
ipcMain.handle('game:installInfo', async () => {
  const installDir     = getStore('game_install_dir') || getDefaultInstallDir();
  const installedVer   = getStore('installed_version') || null;
  const exePath        = getGameExecutable(installDir);
  const installed      = fs.existsSync(exePath);
  return { installed, installedVer, installDir, exePath };
});
