import { app, BrowserWindow, dialog, ipcMain, protocol, screen, session, shell } from 'electron';
import path from 'node:path';
import { promises as fs, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { Store } from './store';
import { catalogSchema, playbackResultSchema, presentationCommandSchema, presentationStateSchema, videoSchema,
  type Catalog, type PlaybackResult, type PresentationSession, type PresentationState, type Workspace } from '../shared/model';

// Keep fullscreen controls above video instead of using a separate Windows video overlay.
if (process.platform === 'win32') app.commandLine.appendSwitch('disable_direct_composition_video_overlays', '1');
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
let presentation: {
  session: PresentationSession; window: BrowserWindow; source: Store; media: Map<string, string>;
  state?: PresentationState; stop?: Promise<void>; finishStop?: () => void; timeout?: ReturnType<typeof setTimeout>;
} | undefined;
let focusTimer: ReturnType<typeof setTimeout> | undefined;
const applicationFocused = () => !!((window && !window.isDestroyed() && window.isFocused()) ||
  (presentation && !presentation.window.isDestroyed() && presentation.window.isFocused()));
function sendFocus() {
  clearTimeout(focusTimer);
  const focused = applicationFocused();
  if (window && !window.isDestroyed()) window.webContents.send('window:focus', focused);
  presentation?.window.webContents.send('window:focus', focused);
}
function queueFocus() {
  clearTimeout(focusTimer);
  focusTimer = setTimeout(sendFocus, 0);
}
function presentationDisplays() {
  const speaker = screen.getDisplayMatching(window.getBounds()).id;
  return screen.getAllDisplays().filter(display => display.id !== speaker).map(display => ({
    id: display.id, label: display.label || `Display ${display.id}`, width: display.size.width, height: display.size.height
  }));
}
function closePresentation(reason?: string, result?: PlaybackResult) {
  const current = presentation;
  if (!current) return;
  presentation = undefined;
  clearTimeout(current.timeout);
  if (!current.window.isDestroyed()) { current.window.hide(); current.window.destroy(); }
  if (!window.isDestroyed()) window.webContents.send('presentation:stopped', {
    id: current.session.id, result: result ?? (current.state && { index: current.state.index, state: current.state.state }), reason
  });
  current.finishStop?.();
  if (store?.path !== current.source.path) setTimeout(() => { void removeDraft(current.source); }, 250).unref();
  queueFocus();
}
function requestPresentationStop() {
  const current = presentation;
  if (!current) return Promise.resolve();
  if (!current.stop) {
    current.stop = new Promise<void>(resolve => { current.finishStop = resolve; });
    current.timeout = setTimeout(() => closePresentation(), 1500);
    current.window.webContents.send('presentation:command', { kind: 'stop' });
  }
  return current.stop;
}
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
  if (presentation?.source.path === previous.path) return;
  const root = path.join(app.getPath('userData'), 'projects');
  if (path.dirname(previous.path).toLowerCase() !== root.toLowerCase() ||
    !/^[a-f0-9-]{36}$/.test(path.basename(previous.path))) return;
  await fs.rm(previous.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
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
  window.on('blur', queueFocus);
  window.on('focus', sendFocus);
  window.on('move', () => {
    if (window.isDestroyed()) return;
    if (presentation?.session.displayId === screen.getDisplayMatching(window.getBounds()).id)
      closePresentation('Presenter window moved to the audience display. Presentation stopped.');
    window.webContents.send('presentation:displays', presentationDisplays());
  });
  window.on('closed', () => closePresentation());
  await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}
if (locked) app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  protocol.handle('demo-media', async request => {
    try {
      const url = new URL(request.url);
      const media = url.pathname.slice(1);
      if (url.hostname !== 'asset' || !/^[a-f0-9-]+\.(mp4|webm)$/.test(media)) return new Response('Not found', { status: 404 });
      const presentationId = url.searchParams.get('presentation');
      const file = presentationId ? (presentation?.session.id === presentationId && presentation.media.get(media)) : await requiredStore().mediaPath(media);
      if (!file) return new Response('Media unavailable', { status: 404 });
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
    progress('Loading...');
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
    progress('Loading...');
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
  ipcMain.handle('project:delete', (_event, value: Catalog, id: string) => operation(async signal => {
    const current = requiredStore();
    const original = current.snapshot().catalog;
    const project = original.projects.find(project => project.id === id);
    if (!project || !Array.isArray(value?.projects) || !Array.isArray(value?.videos) ||
      !value.projects.some(project => project.id === id)) throw new Error('Project no longer exists.');
    const projects = value.projects.filter(project => project.id !== id);
    const used = new Set(projects.flatMap(project => project.videos));
    const remaining = catalogSchema.parse({ ...value, projects, videos: value.videos.filter(video => used.has(video.id)) });
    const file = id === selectedProjectId ? projectFile : undefined;
    const name = value.projects.find(project => project.id === id)!.name.trim() || project.name;
    const result = await dialog.showMessageBox(window, {
      type: 'warning', buttons: ['Cancel', 'Delete project'], defaultId: 0, cancelId: 0, noLink: true,
      message: `Delete "${name}"?`,
      detail: `${file ? `The project file will be moved to the Recycle Bin:\n${file}` : 'This unsaved project will be discarded.'}\n\nUnsaved changes will be discarded. Original video recordings and other projects will not be deleted.`
    });
    if (result.response !== 1) return false;
    signal.throwIfAborted();
    const previousFile = projectFile, previousId = selectedProjectId;
    try {
      if (remaining.projects.length) {
        await current.save(remaining);
        projectFile = undefined; selectedProjectId = remaining.projects[0].id;
        await remember();
      } else {
        await fs.rm(path.join(app.getPath('userData'), 'workspace.json'), { force: true });
      }
      if (file) {
        const stat = await fs.lstat(file).catch(error => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        if (stat && !stat.isFile()) throw new Error('The project path is no longer a regular file.');
        if (stat) await shell.trashItem(file);
      }
    } catch (error) {
      projectFile = previousFile; selectedProjectId = previousId;
      if (remaining.projects.length) await current.save(original);
      await remember();
      throw error;
    }
    if (!remaining.projects.length) {
      store = undefined; projectFile = undefined; selectedProjectId = undefined;
      await removeDraft(current);
    }
    return true;
  }));
  ipcMain.handle('media:import', () => operation(async signal => {
    const result = await dialog.showOpenDialog(window, { filters: [{ name: 'Demo video (cursor-free)', extensions: ['mp4', 'webm'] }], properties: ['openFile'] });
    if (result.canceled) return null;
    progress('Loading...');
    return requiredStore().importMedia(result.filePaths[0], signal, progress);
  }));
  ipcMain.handle('operation:cancel', () => cancellation?.abort());
  ipcMain.handle('window:fullscreen', (_event, enabled) => { if (typeof enabled !== 'boolean') throw new Error('Invalid fullscreen request.'); window.setFullScreen(enabled); });
  const requireSpeaker = (sender: Electron.WebContents) => {
    if (sender !== window.webContents) throw new Error('This operation is available only in the presenter window.');
  };
  ipcMain.handle('presentation:displays', event => { requireSpeaker(event.sender); return presentationDisplays(); });
  ipcMain.handle('presentation:start', (event, displayId, value) => operation(async () => {
    requireSpeaker(event.sender);
    if (presentation) throw new Error('Stop the current presentation before starting another.');
    const display = screen.getAllDisplays().find(display => display.id === displayId);
    if (!display || !presentationDisplays().some(display => display.id === displayId))
      throw new Error('Choose a connected monitor other than the presenter monitor.');
    const videos = videoSchema.array().min(1).max(10000).parse(value);
    const source = requiredStore();
    const media = new Map(await Promise.all([...new Set(videos.map(video => video.media))].map(async media => [media, await source.mediaPath(media)] as const)));
    const audience = new BrowserWindow({
      ...display.bounds, show: false, frame: false, autoHideMenuBar: true, title: 'Demo Simulator - Audience',
      backgroundColor: '#000000',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
        sandbox: true, backgroundThrottling: false }
    });
    audience.setMenu(null);
    audience.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    audience.webContents.on('will-navigate', event => event.preventDefault());
    const session: PresentationSession = { id: randomUUID(), displayId, videos, focused: applicationFocused() };
    presentation = { session, window: audience, source, media };
    audience.on('focus', sendFocus); audience.on('blur', queueFocus);
    audience.on('closed', () => { if (presentation?.window === audience) closePresentation(); });
    audience.webContents.on('render-process-gone', () => {
      if (presentation?.window === audience) closePresentation('Audience playback stopped unexpectedly. Start the presentation again.');
    });
    try {
      await audience.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { audience: '1' } });
      if (presentation?.window !== audience) throw new Error('The audience display was closed while starting.');
      audience.setFullScreen(true); audience.showInactive(); sendFocus();
      return session;
    } catch (error) { if (presentation?.window === audience) closePresentation(); throw error; }
  }));
  ipcMain.handle('presentation:current', event => {
    if (event.sender !== presentation?.window.webContents) return null;
    return { ...presentation.session, focused: applicationFocused() };
  });
  ipcMain.handle('presentation:state', (event, id) => {
    requireSpeaker(event.sender);
    return presentation && presentation.session.id === id ? presentation.state ?? null : null;
  });
  ipcMain.on('presentation:state', (event, value) => {
    if (event.sender !== presentation?.window.webContents) return;
    const parsed = presentationStateSchema.safeParse(value);
    if (!parsed.success || parsed.data.id !== presentation.session.id || parsed.data.index >= presentation.session.videos.length) return;
    presentation.state = parsed.data;
    window.webContents.send('presentation:state', parsed.data);
  });
  ipcMain.handle('presentation:command', (event, id, value) => {
    requireSpeaker(event.sender);
    if (!presentation || presentation.session.id !== id) throw new Error('This presentation has stopped.');
    const command = presentationCommandSchema.parse(value);
    if (command.kind === 'stop') return requestPresentationStop();
    sendFocus();
    presentation.window.webContents.send('presentation:command', command);
  });
  ipcMain.handle('presentation:stop', (event, id) => {
    requireSpeaker(event.sender);
    if (presentation?.session.id === id) return requestPresentationStop();
  });
  ipcMain.handle('presentation:finish', (event, id, value) => {
    if (event.sender !== presentation?.window.webContents || id !== presentation.session.id) return;
    const result = playbackResultSchema.parse(value);
    if (result.index >= presentation.session.videos.length) throw new Error('Invalid playback position.');
    closePresentation(undefined, result);
  });
  const updateDisplays = () => {
    if (window && !window.isDestroyed()) window.webContents.send('presentation:displays', presentationDisplays());
  };
  screen.on('display-added', updateDisplays);
  screen.on('display-metrics-changed', updateDisplays);
  screen.on('display-removed', (_event, display) => {
    if (presentation?.session.displayId === display.id) closePresentation('Audience display disconnected. Presentation stopped.');
    updateDisplays();
  });
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
