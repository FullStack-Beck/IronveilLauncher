const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { exec, spawn, execFile } = require('child_process');
const fs   = require('fs');
const https = require('https');
const os   = require('os');

let mainWindow;
let gameProcess = null;
let serverProcess = null;
let activeServerProfileId = null;
const serverLogBuffers = new Map();

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
    if (serverProcess && !serverProcess.killed) serverProcess.kill();
    writeServersFile({ noRunning: true });   // the exit event may never fire once the app is quitting
  });
}

app.whenReady().then(() => { createWindow(); writeServersFile(); });
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

// ── Dedicated server manager ───────────────────────────────────
const crypto = require('crypto');

function serverStatus() {
  return { running: !!serverProcess && serverProcess.exitCode === null, profileId: activeServerProfileId, pid: serverProcess?.pid || null };
}
function emitServerState() { mainWindow?.webContents.send('server:state', serverStatus()); }
function pushServerLog(profileId, line) {
  const lines = serverLogBuffers.get(profileId) || [];
  lines.push(String(line).replace(/\r$/, ''));
  if (lines.length > 500) lines.splice(0, lines.length - 500);
  serverLogBuffers.set(profileId, lines);
  mainWindow?.webContents.send('server:log', { profileId, line: lines[lines.length - 1] });
}
function parseServerArguments(input) {
  const result = [], pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(input || ''))) result.push(match[1] ?? match[2] ?? match[3]);
  return result;
}

// ── Server list for the game (servers.json) ────────────────────
// The game's FileServerDirectory (MyServers list) reads this file. It lives in a shared folder, NOT in Unity's
// persistentDataPath: that path contains the Player Settings company name ("DefaultCompany" for now), which will change.
//   Windows %APPDATA%\Ironveil\servers.json | macOS ~/Library/Application Support/Ironveil | Linux ~/.config/Ironveil
// Entry fields are exactly the Unity ServerEntry fields. Rewritten after every change to profiles, private servers
// or the running server process.
// Only the RUNNING profile is listed (joining a stopped server would just time out). Set to true to list all profiles.
const INCLUDE_STOPPED_PROFILES = false;

function getServersFilePath() {
  return path.join(app.getPath('appData'), 'Ironveil', 'servers.json');
}

function writeServersFile(options = {}) {
  try {
    const runningId = options.noRunning ? null
      : (serverProcess && serverProcess.exitCode === null ? activeServerProfileId : null);
    const servers = [];

    for (const p of getStore('server_profiles') || []) {
      if (p.id !== runningId && !INCLUDE_STOPPED_PROFILES) continue;
      servers.push({
        id: `profile-${p.id}`, name: p.name,
        players: 0,                       // placeholder: nothing reports player counts yet (roadmap stage 4c)
        maxPlayers: p.maxPlayers, version: '', locked: false, favorite: false, mine: true,
        address: `127.0.0.1:${p.port}`,
      });
    }
    for (const s of getStore('private_servers') || []) {
      servers.push({
        id: `private-${s.id}`, name: s.name,
        players: 0, maxPlayers: 0,        // unknown
        version: '', locked: false, favorite: false, mine: true,
        address: `${s.address}:${s.port}`,
      });
    }

    const file = getServersFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const json = JSON.stringify({ servers }, null, 2);
    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, file);           // atomic swap: the game never reads half a file
    } catch {
      fs.writeFileSync(file, json);       // rename can fail on Windows while the game has the file open
      try { fs.unlinkSync(tmp); } catch {}
    }
  } catch (err) {
    console.error('[Launcher] Could not write servers.json:', err.message);
  }
}

ipcMain.handle('server:profiles:get', async () => getStore('server_profiles') || []);
ipcMain.handle('server:profiles:save', async (_, profile) => {
  try {
    if (!profile || typeof profile.name !== 'string' || !profile.name.trim()) return { success:false, error:'A server name is required.' };
    if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) return { success:false, error:'Port must be between 1 and 65535.' };
    if (!Number.isInteger(profile.maxPlayers) || profile.maxPlayers < 1 || profile.maxPlayers > 64) return { success:false, error:'Maximum players must be between 1 and 64.' };
    const profiles = getStore('server_profiles') || [];
    if (profile.id && serverProcess && activeServerProfileId === profile.id) return { success:false, error:'Stop this server before changing its profile.' };
    const saved = { id:profile.id || crypto.randomUUID(), name:profile.name.trim().slice(0,40), port:profile.port, maxPlayers:profile.maxPlayers, world:String(profile.world||'').trim().slice(0,48), args:String(profile.args||'').slice(0,2000), visibility:profile.visibility === 'public' ? 'public' : 'private' };
    const i = profiles.findIndex(x => x.id === saved.id); if (i >= 0) profiles[i] = saved; else profiles.push(saved);
    setStore('server_profiles', profiles); writeServersFile(); return { success:true, profile:saved };
  } catch (err) { return { success:false, error:err.message }; }
});
ipcMain.handle('server:profiles:delete', async (_, id) => {
  if (serverProcess && activeServerProfileId === id) return { success:false, error:'Stop the server before deleting its profile.' };
  setStore('server_profiles', (getStore('server_profiles') || []).filter(p => p.id !== id)); serverLogBuffers.delete(id); writeServersFile(); return { success:true };
});
ipcMain.handle('server:executable:get', async () => getStore('server_executable') || null);
ipcMain.handle('server:executable:set', async (_, executable) => {
  if (executable && (!path.isAbsolute(executable) || !fs.existsSync(executable))) return { success:false, error:'The selected server executable does not exist.' };
  setStore('server_executable', executable || null); return { success:true };
});
ipcMain.handle('server:executable:browse', async () => {
  const { dialog } = require('electron');
  const filters = process.platform === 'win32' ? [{ name:'Dedicated Server', extensions:['exe'] }] : [{ name:'Dedicated Server', extensions:['*'] }];
  const result = await dialog.showOpenDialog(mainWindow, { title:'Locate Ironveil Dedicated Server', properties:['openFile'], filters });
  return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
});
ipcMain.handle('server:status', async () => serverStatus());
ipcMain.handle('server:logs', async (_, id) => serverLogBuffers.get(id) || []);
ipcMain.handle('server:start', async (_, profileId) => {
  if (serverProcess && serverProcess.exitCode === null) return { success:false, error:'A dedicated server is already running. Stop it before starting another.' };
  const profile = (getStore('server_profiles') || []).find(p => p.id === profileId);
  if (!profile) return { success:false, error:'Server profile not found.' };
  const executable = getStore('server_executable');
  if (!executable || !fs.existsSync(executable)) return { success:false, error:'Locate a dedicated server executable before starting a server.' };
  const vars = { port:String(profile.port), name:profile.name, maxPlayers:String(profile.maxPlayers), world:profile.world || 'World' };
  const expanded = String(profile.args || '').replace(/\{(port|name|maxPlayers|world)\}/g, (_, k) => vars[k]);
  const args = parseServerArguments(expanded);
  try {
    const child = spawn(executable, args, { cwd:path.dirname(executable), windowsHide:true, detached:false, stdio:['ignore','pipe','pipe'] });
    serverProcess = child; activeServerProfileId = profile.id; serverLogBuffers.set(profile.id, []);
    pushServerLog(profile.id, `[Launcher] Starting ${profile.name}`); pushServerLog(profile.id, `[Launcher] ${executable} ${args.join(' ')}`);
    const attach = (stream, prefix) => { let pending=''; stream.on('data', chunk => { pending += chunk.toString(); const parts=pending.split(/\r?\n/); pending=parts.pop()||''; parts.forEach(line => pushServerLog(profile.id, prefix+line)); }); stream.on('end',()=>{ if(pending) pushServerLog(profile.id,prefix+pending); }); };
    attach(child.stdout,''); attach(child.stderr,'[stderr] ');
    child.once('error', err => { pushServerLog(profile.id, `[Launcher] Failed to start: ${err.message}`); if(serverProcess===child){serverProcess=null;activeServerProfileId=null;} writeServersFile(); emitServerState(); });
    child.once('exit',(code,signal)=>{ pushServerLog(profile.id, `[Launcher] Process exited (code=${code}, signal=${signal||'none'})`); if(serverProcess===child){serverProcess=null;activeServerProfileId=null;} writeServersFile(); emitServerState(); });
    writeServersFile(); emitServerState(); return { success:true, status:serverStatus() };
  } catch(err) { serverProcess=null; activeServerProfileId=null; writeServersFile(); return { success:false, error:err.message }; }
});
ipcMain.handle('server:stop', async () => {
  if (!serverProcess) return { success:false, error:'No server process is running.' };
  try { serverProcess.kill(); pushServerLog(activeServerProfileId, '[Launcher] Stop requested.'); return { success:true, status:serverStatus() }; }
  catch(err) { return { success:false, error:err.message }; }
});
ipcMain.handle('private-servers:get', async () => getStore('private_servers') || []);
ipcMain.handle('private-servers:add', async (_, entry) => {
  if (!entry || !String(entry.name||'').trim() || !String(entry.address||'').trim()) return { success:false, error:'Name and address are required.' };
  if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) return { success:false, error:'Port must be between 1 and 65535.' };
  const servers=getStore('private_servers')||[];
  if(servers.some(x=>x.address.toLowerCase()===entry.address.trim().toLowerCase()&&x.port===entry.port)) return {success:false,error:'That address and port are already saved.'};
  const saved={id:crypto.randomUUID(),name:String(entry.name).trim().slice(0,48),address:String(entry.address).trim().slice(0,255),port:entry.port};
  servers.push(saved);setStore('private_servers',servers);writeServersFile();return {success:true,entry:saved};
});
ipcMain.handle('private-servers:remove', async (_, id) => { setStore('private_servers',(getStore('private_servers')||[]).filter(x=>x.id!==id));writeServersFile();return {success:true}; });

// ── Game directories ─────────────────────────────────────────
function getDefaultInstallDir() {
  const platform = process.platform;
  if (platform === 'win32') {
    // per-user folder: writing to Program Files would need admin rights
    const local = process.env['LOCALAPPDATA'] || path.join(app.getPath('home'), 'AppData', 'Local');
    return path.join(local, 'Programs', 'Ironveil');
  } else if (platform === 'darwin') {
    return path.join(app.getPath('home'), 'Applications', 'Ironveil');
  }
  return path.join(app.getPath('home'), 'Ironveil');
}

/** Build output is Ironveil.exe; ProjectIronveil.* is kept as a fallback for old manual installs. */
function gameExeNames() {
  if (process.platform === 'win32')  return ['Ironveil.exe', 'ProjectIronveil.exe'];
  if (process.platform === 'darwin') return ['Ironveil.app', 'ProjectIronveil.app'];
  return ['Ironveil', 'ProjectIronveil'];
}

function getGameExecutable(installDir) {
  const names = gameExeNames();
  for (const n of names) {
    const p = path.join(installDir, n);
    if (fs.existsSync(p)) return p;
  }
  return path.join(installDir, names[0]);
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
    getGameExecutable(path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Ironveil')),  // older installs
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
// The renderer asks the `get-latest-build` Supabase Edge function which builds this
// account may download, then hands us a short-lived pre-signed URL. This process never
// sees a GitHub token. (The old releases:list and game:checkUpdate handlers were removed
// on purpose; the renderer does the listing through the Edge function.)
// ═══════════════════════════════════════════════════════════════

const DOWNLOAD_HOST_SUFFIXES = ['github.com', 'githubusercontent.com'];

function isAllowedDownloadUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' &&
      DOWNLOAD_HOST_SUFFIXES.some(s => url.hostname === s || url.hostname.endsWith('.' + s));
  } catch { return false; }
}

/** Download a (pre-signed) URL to a file, following redirects. No auth header: the URL carries its own. */
function downloadToFile(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    if (!isAllowedDownloadUrl(url)) return reject(new Error('Download URL not allowed'));
    const req = https.get(url, { headers: { 'User-Agent': 'IronveilLauncher/1.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        downloadToFile(new URL(res.headers.location, url).toString(), dest, onProgress, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed (HTTP ${res.statusCode}). The link may have expired; try again.`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      const file = fs.createWriteStream(dest);
      res.on('data', (chunk) => { received += chunk.length; onProgress(received, total); });
      res.on('error', (e) => { file.destroy(); reject(e); });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    });
    req.setTimeout(30000, () => req.destroy(new Error('Download timed out')));
    req.on('error', reject);
  });
}

function runFile(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024, ...opts }, (err, _out, stderr) => {
      if (err) reject(new Error((stderr || err.message || 'command failed').toString().trim()));
      else resolve();
    });
  });
}

/** Extract a .zip. Windows: built-in tar.exe (fast), falling back to PowerShell. Others: unzip. */
async function extractArchive(zipPath, destDir) {
  if (!zipPath.toLowerCase().endsWith('.zip')) throw new Error('Unsupported build format (expected a .zip).');
  if (process.platform === 'win32') {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    try { await runFile(tar, ['-xf', zipPath, '-C', destDir]); return; } catch { /* fall through */ }
    await runFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -Force -LiteralPath $env:IV_ZIP -DestinationPath $env:IV_DEST'
    ], { env: { ...process.env, IV_ZIP: zipPath, IV_DEST: destDir } });
  } else {
    await runFile('unzip', ['-oq', zipPath, '-d', destDir]);
  }
}

function hasGameExe(dir) {
  return gameExeNames().some(n => fs.existsSync(path.join(dir, n)));
}

/** The folder that actually contains the game exe: the zip root, or its single top-level folder. */
function findBuildRoot(dir) {
  if (hasGameExe(dir)) return dir;
  const subdirs = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory());
  if (subdirs.length === 1) {
    const sub = path.join(dir, subdirs[0].name);
    if (hasGameExe(sub)) return sub;
  }
  return null;
}

let installing = false;

/**
 * Install a build.  Renderer passes { url, assetName, version } where url comes from
 * get-latest-build (action "download").
 *
 * Flow: download zip to temp -> extract to "<installDir>.new" -> rename old dir to ".old"
 * -> rename new into place -> delete old. If the game is running the rename fails and the
 * old install is left untouched.
 *
 * Events to renderer:
 *   'install:status'   { message }
 *   'install:progress' { percent, bytesReceived, totalBytes }
 *   'install:done'     { success, error? }
 */
ipcMain.handle('game:install', async (_, { url, assetName, version }) => {
  if (installing) return { success: false, error: 'An install is already running.' };
  installing = true;

  const send = (channel, payload) => mainWindow?.webContents.send(channel, payload);
  const finish = (result) => { installing = false; send('install:done', result); return result; };

  const safeName   = path.basename(String(assetName || 'ironveil-build.zip'));
  const targetDir  = getStore('game_install_dir') || getDefaultInstallDir();
  const stagingDir = targetDir + '.new';
  const oldDir     = targetDir + '.old';
  const tmpFile    = path.join(os.tmpdir(), `ironveil-${Date.now()}-${safeName}`);

  try {
    // Safety: this code deletes/replaces targetDir, so never do it for an unexpected folder.
    if (path.basename(targetDir).toLowerCase() !== 'ironveil') {
      throw new Error(`Refusing to install into "${targetDir}".`);
    }

    send('install:status', { message: 'Downloading build…' });
    await downloadToFile(url, tmpFile, (received, total) => {
      send('install:progress', {
        percent: total ? Math.round((received / total) * 100) : 0,
        bytesReceived: received,
        totalBytes: total
      });
    });

    send('install:status', { message: 'Extracting build…' });
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    await extractArchive(tmpFile, stagingDir);

    const buildRoot = findBuildRoot(stagingDir);
    if (!buildRoot) throw new Error('The downloaded build does not contain the game executable (Ironveil.exe).');

    send('install:status', { message: 'Replacing old version…' });
    fs.rmSync(oldDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    if (fs.existsSync(targetDir)) {
      try { fs.renameSync(targetDir, oldDir); }
      catch { throw new Error('Could not replace the old version. Close Ironveil and try again.'); }
    }
    try { fs.renameSync(buildRoot, targetDir); }
    catch (e) {
      try { if (fs.existsSync(oldDir)) fs.renameSync(oldDir, targetDir); } catch {}
      throw e;
    }
    try { fs.rmSync(oldDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch {}

    setStore('installed_version', version);
    setStore('game_install_dir', targetDir);
    return finish({ success: true });
  } catch (err) {
    return finish({ success: false, error: err.message });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
  }
});

ipcMain.handle('app:version', () => app.getVersion());

/**
 * Uninstall: remove the game directory and clear stored version.
 */
ipcMain.handle('game:uninstall', async () => {
  const installDir = getStore('game_install_dir');
  if (!installDir || !fs.existsSync(installDir)) {
    return { success: false, error: 'No installed game found.' };
  }
  if (path.basename(installDir).toLowerCase() !== 'ironveil') {
    return { success: false, error: `Refusing to delete "${installDir}".` };
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