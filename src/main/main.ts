import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron';
import path from 'node:path';
import { promises as fs, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { Store } from './store';
import { catalogSchema, type Workspace } from '../shared/model';

protocol.registerSchemesAsPrivileged([{ scheme: 'demo-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
const profileArgument = process.argv.find(argument => argument.startsWith('--user-data-dir='));
if (profileArgument) app.setPath('userData', path.resolve(profileArgument.slice('--user-data-dir='.length)));
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
let window: BrowserWindow;
let store: Store | undefined;
let projectFile: string | undefined;
let selectedProjectId: string | undefined;
let restoring: Promise<void> = Promise.resolve();
let busy = false;
let cancellation: AbortController | undefined;
async function operation<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (busy) throw new Error('Another file operation is in progress.');
  busy = true; cancellation = new AbortController();
  try { return await fn(cancellation.signal); }
  finally { busy = false; cancellation = undefined; window?.webContents.send('operation:progress', ''); }
}
const progress = (message: string) => window.webContents.send('operation:progress', message);
const requiredStore = () => { if (!store) throw new Error('Create or open a project first.'); return store; };
const snapshot = (): Workspace | null => store ? { ...store.snapshot(), filePath: projectFile, projectId: selectedProjectId } : null;
async function remember() {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(path.join(app.getPath('userData'), 'workspace.json'), JSON.stringify({ path: requiredStore().path, filePath: projectFile, projectId: selectedProjectId }));
}
async function draft() {
  const directory = path.join(app.getPath('userData'), 'projects', randomUUID());
  return Store.open(directory);
}
async function removeDraft(previous: Store) {
  const root = path.join(app.getPath('userData'), 'projects');
  if (path.dirname(previous.path).toLowerCase() !== root.toLowerCase() ||
    !/^[a-f0-9-]{36}$/.test(path.basename(previous.path))) return;
  await fs.rm(previous.path, { recursive: true, force: true }).catch(() => {});
}
async function activate(next: Store, filePath?: string) {
  const previous = store;
  store = next; projectFile = filePath;
  selectedProjectId = next.snapshot().catalog.projects[0]?.id;
  await remember();
  if (previous && previous.path !== next.path) await removeDraft(previous);
  return snapshot();
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600, title: 'Demo Simulator',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-prevent-unload', event => {
    if (busy) {
      dialog.showMessageBoxSync(window, { type: 'info', message: 'A file operation is in progress.', detail: 'Wait for it to finish or cancel it before closing.' });
      return;
    }
    const choice = dialog.showMessageBoxSync(window, {
      type: 'question', buttons: ['Keep editing', 'Discard and close'], defaultId: 0, cancelId: 0,
      message: 'Discard unsaved project changes?'
    });
    if (choice === 1) event.preventDefault();
  });
  window.on('enter-full-screen', () => window.webContents.send('window:fullscreen', true));
  window.on('leave-full-screen', () => window.webContents.send('window:fullscreen', false));
  window.on('blur', () => window.webContents.send('window:focus', false));
  window.on('focus', () => window.webContents.send('window:focus', true));
  await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}
if (locked) app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  protocol.handle('demo-media', async request => {
    try {
      const url = new URL(request.url);
      const media = url.pathname.slice(1);
      if (url.hostname !== 'asset' || !/^[a-f0-9-]+\.(mp4|webm)$/.test(media)) return new Response('Not found', { status: 404 });
      const file = await requiredStore().mediaPath(media);
      const size = (await fs.stat(file)).size;
      const range = request.headers.get('range');
      let start = 0, end = size - 1;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        if (!match[1]) start = Math.max(0, size - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      }
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      const headers: Record<string, string> = {
        'Content-Type': media.endsWith('.mp4') ? 'video/mp4' : 'video/webm',
        'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
        'Access-Control-Allow-Origin': '*'
      };
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      const stream = createReadStream(file, { start, end });
      return new Response(Readable.toWeb(stream) as ReadableStream, { status: range ? 206 : 200, headers });
    } catch { return new Response('Media unavailable', { status: 404 }); }
  });
  ipcMain.handle('project:current', async () => { await restoring; return snapshot(); });
  ipcMain.handle('project:new', () => operation(async () => {
    const next = await draft();
    await next.save({ version: 2, videos: [], projects: [{ id: randomUUID(), name: 'Untitled project', videos: [] }] });
    return activate(next);
  }));
  ipcMain.handle('project:open', () => operation(async signal => {
    const result = await dialog.showOpenDialog(window, { title: 'Open demo project', filters: [{ name: 'Demo Simulator project', extensions: ['demosim'] }], properties: ['openFile'] });
    if (result.canceled) return null;
    const next = await draft();
    try {
      await next.importBundle(result.filePaths[0], false, signal, progress);
      if (!next.snapshot().catalog.projects.length) throw new Error('This file contains no projects.');
    } catch (error) { await removeDraft(next); throw error; }
    return activate(next, result.filePaths[0]);
  }));
  ipcMain.handle('project:legacy', () => operation(async signal => {
    const result = await dialog.showOpenDialog(window, { title: 'Open previous-version workspace folder', properties: ['openDirectory'] });
    if (result.canceled) return null;
    await fs.access(path.join(result.filePaths[0], 'catalog.json'));
    const source = await Store.open(result.filePaths[0]);
    const next = await draft();
    try { await next.copyFrom(source, signal, progress); }
    catch (error) { await removeDraft(next); throw error; }
    return activate(next);
  }));
  ipcMain.handle('project:save', (_event, value, id, saveAs) => operation(async signal => {
    const catalog = catalogSchema.parse(value);
    const project = catalog.projects.find(project => project.id === id);
    if (!project || typeof saveAs !== 'boolean') throw new Error('Invalid project save.');
    let destination = id === selectedProjectId ? projectFile : undefined;
    if (!destination || saveAs) {
      const result = await dialog.showSaveDialog(window, {
        title: 'Save demo project', defaultPath: destination ?? `${project.name.replace(/[<>:"/\\|?*]/g, '_')}.demosim`,
        filters: [{ name: 'Demo Simulator project (includes videos)', extensions: ['demosim'] }]
      });
      if (result.canceled || !result.filePath) return null;
      destination = result.filePath;
    }
    // Keep recovery data separate from the user's portable document.
    await requiredStore().exportBundle(id, destination, signal, progress, catalog);
    await requiredStore().save(catalog);
    projectFile = destination; selectedProjectId = id;
    await remember();
    return snapshot();
  }));
  ipcMain.handle('media:import', () => operation(async signal => {
    const result = await dialog.showOpenDialog(window, { filters: [{ name: 'Demo video (cursor-free)', extensions: ['mp4', 'webm'] }], properties: ['openFile'] });
    if (result.canceled) return null;
    return requiredStore().importMedia(result.filePaths[0], signal, progress);
  }));
  ipcMain.handle('operation:cancel', () => cancellation?.abort());
  ipcMain.handle('window:fullscreen', (_event, enabled) => { if (typeof enabled !== 'boolean') throw new Error('Invalid fullscreen request.'); window.setFullScreen(enabled); });
  restoring = (async () => {
    try {
      const remembered = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'workspace.json'), 'utf8'));
      if (typeof remembered.path !== 'string' || !(await fs.stat(remembered.path)).isDirectory()) return;
      store = await Store.open(remembered.path);
      if (typeof remembered.filePath === 'string') projectFile = remembered.filePath;
      if (typeof remembered.projectId === 'string') selectedProjectId = remembered.projectId;
    } catch { /* The welcome screen remains usable when the prior project is unavailable. */ }
  })();
  await createWindow();
});
app.on('window-all-closed', () => app.quit());
