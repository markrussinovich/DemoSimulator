import path from 'node:path';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import * as yauzl from 'yauzl';
import * as yazl from 'yazl';
import { catalogSchema, parseCatalog, type Catalog, type Workspace, mediaUrl } from '../shared/model';

const MAX_BYTES = 32 * 1024 ** 3;
const MAX_ENTRIES = 20000;
const MAX_JSON = 16 * 1024 ** 2;
const emptyCatalog = (): Catalog => ({ version: 2, videos: [], projects: [] });
type Progress = (message: string) => void;

export function safeArchivePath(name: string): boolean {
  if (name.includes('\\') || name.startsWith('/') || name.includes(':') || name.includes('\0')) return false;
  const parts = name.split('/');
  return parts.every(part => part !== '' && part !== '.' && part !== '..' &&
    !/[<>:"|?*]/.test(part) && ![...part].some(char => char.charCodeAt(0) < 32) && !/[. ]$/.test(part) &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(part));
}
async function exists(file: string) {
  try { await fs.access(file); return true; } catch { return false; }
}
async function copy(source: string, target: string, signal: AbortSignal, progress: Progress) {
  const stat = await fs.stat(source);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('File is not a regular file or exceeds the 32 GiB limit.');
  let bytes = 0;
  let percent = -1;
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    const next = Math.round(bytes / Math.max(1, stat.size) * 100);
    if (next !== percent) { percent = next; progress(`Copying media: ${percent}%`); }
    callback(null, chunk);
  } });
  await pipeline(createReadStream(source), meter, createWriteStream(target, { flags: 'wx' }), { signal });
}
async function readCatalog(file: string): Promise<Catalog> {
  if ((await fs.stat(file)).size > MAX_JSON) throw new Error('Workspace catalog exceeds 16 MiB.');
  return parseCatalog(JSON.parse(await fs.readFile(file, 'utf8')));
}

export class Store {
  private catalog: Catalog = emptyCatalog();
  private recovery?: string;
  private constructor(readonly path: string) {}
  static async open(directory: string): Promise<Store> {
    await fs.mkdir(directory, { recursive: true });
    const store = new Store(await fs.realpath(directory));
    await fs.mkdir(path.join(store.path, 'media'), { recursive: true });
    const current = path.join(store.path, 'catalog.json');
    const backup = path.join(store.path, 'catalog.backup.json');
    if (await exists(current) || await exists(backup)) {
      try { store.catalog = await readCatalog(current); }
      catch {
        store.catalog = await readCatalog(backup);
        store.recovery = 'Recovered the prior catalog. Save to commit the recovered version.';
      }
    }
    return store;
  }
  snapshot(): Workspace { return { path: this.path, catalog: structuredClone(this.catalog), recovery: this.recovery }; }
  async copyFrom(source: Store, signal: AbortSignal, progress: Progress) {
    const catalog = source.snapshot().catalog;
    const mapping = new Map<string, string>();
    for (const media of new Set(catalog.videos.map(video => video.media))) {
      const imported = await this.importMedia(await source.mediaPath(media), signal, progress);
      mapping.set(media, imported.media);
    }
    signal.throwIfAborted();
    await this.save({ ...catalog, videos: catalog.videos.map(video => ({ ...video, media: mapping.get(video.media)! })) });
  }
  async mediaPath(media: string) {
    if (!/^[a-f0-9-]+\.(mp4|webm)$/.test(media)) throw new Error('Invalid managed media name.');
    const base = await fs.realpath(path.join(this.path, 'media'));
    const file = await fs.realpath(path.join(base, media));
    if (path.dirname(file).toLowerCase() !== base.toLowerCase()) throw new Error('Media path escapes the workspace.');
    if (!(await fs.stat(file)).isFile()) throw new Error('Media unavailable.');
    return file;
  }
  async save(value: unknown): Promise<Catalog> {
    const next = catalogSchema.parse(value);
    for (const p of next.videos) await this.mediaPath(p.media);
    const file = path.join(this.path, 'catalog.json');
    const temp = path.join(this.path, `catalog-${randomUUID()}.tmp`);
    const backup = path.join(this.path, 'catalog.backup.json');
    const serialized = JSON.stringify(next, null, 2);
    if (Buffer.byteLength(serialized) > MAX_JSON) throw new Error('Catalog exceeds 16 MiB.');
    try {
      const handle = await fs.open(temp, 'wx');
      try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
      // Never replace a valid backup with a corrupt catalog during recovery.
      if (await exists(file)) {
        try { await readCatalog(file); await fs.copyFile(file, backup); }
        catch (error) { if (!this.recovery) throw error; }
      }
      await fs.rename(temp, file);
      this.catalog = next; this.recovery = undefined;
      return structuredClone(next);
    } finally { await fs.rm(temp, { force: true }); }
  }
  async importMedia(source: string, signal: AbortSignal, progress: Progress) {
    const ext = path.extname(source).toLowerCase();
    if (ext !== '.mp4' && ext !== '.webm') throw new Error('Choose MP4 or WebM.');
    const media = `${randomUUID()}${ext}`;
    const target = path.join(this.path, 'media', media);
    try { await copy(source, target, signal, progress); }
    catch (error) { await fs.rm(target, { force: true }); throw error; }
    return { media, url: mediaUrl(media), name: path.basename(source, path.extname(source)) };
  }
  async exportBundle(id: string, destination: string, signal: AbortSignal, progress: Progress, catalog = this.catalog) {
    const project = catalog.projects.find(p => p.id === id);
    if (!project) throw new Error('Project no longer exists.');
    const videos = catalog.videos.filter(video => project.videos.includes(video.id));
    const bundle: Catalog = { version: 2, videos, projects: [project] };
    const zip = new yazl.ZipFile();
    zip.on('error', error => (zip.outputStream as Readable).destroy(error));
    const serialized = Buffer.from(JSON.stringify(bundle));
    let total = serialized.length;
    const mediaFiles = new Map<string, string>();
    for (const media of new Set(videos.map(p => p.media))) {
      signal.throwIfAborted();
      const file = await this.mediaPath(media);
      total += (await fs.stat(file)).size;
      mediaFiles.set(media, file);
    }
    if (total > MAX_BYTES || serialized.length > MAX_JSON || mediaFiles.size + 1 > MAX_ENTRIES)
      throw new Error('Export exceeds portable archive limits (32 GiB, 20,000 entries, 16 MiB catalog).');
    zip.addBuffer(serialized, 'catalog.json');
    for (const [media, file] of mediaFiles) zip.addFile(file, `media/${media}`, { compress: false });
    const temp = `${destination}.${randomUUID()}.tmp`;
    try {
      progress('Saving project file...');
      const writing = pipeline(zip.outputStream, createWriteStream(temp, { flags: 'wx' }), { signal });
      zip.end();
      await writing;
      signal.throwIfAborted();
      await fs.rename(temp, destination);
    } finally { await fs.rm(temp, { force: true }); }
  }
  async importBundle(source: string, asCopy: boolean, signal: AbortSignal, progress: Progress) {
    if ((await fs.stat(source)).size > MAX_BYTES) throw new Error('Archive exceeds 32 GiB.');
    const staging = path.join(this.path, `import-${randomUUID()}`);
    await fs.mkdir(staging);
    const moved: string[] = [];
    let committed = false;
    try {
      await extractArchive(source, staging, signal, progress);
      const bundle = await readCatalog(path.join(staging, 'catalog.json'));
      const files = new Set(bundle.videos.map(p => p.media));
      const mapping = new Map<string, string>();
      for (const media of files) {
        signal.throwIfAborted();
        const targetName = `${randomUUID()}${path.extname(media)}`;
        const target = path.join(this.path, 'media', targetName);
        await fs.rename(path.join(staging, 'media', media), target);
        moved.push(target); mapping.set(media, targetName);
      }
      const ids = new Map(bundle.videos.map(p => [p.id, asCopy ? randomUUID() : p.id]));
      const videos = bundle.videos.map(p => ({ ...p, id: ids.get(p.id)!, media: mapping.get(p.media)! }));
      const projects = bundle.projects.map(p => ({
        ...p, id: asCopy ? randomUUID() : p.id, videos: p.videos.map(id => ids.get(id)!)
      }));
      signal.throwIfAborted();
      await this.save({
        version: 2,
        videos: [...this.catalog.videos.filter(p => !videos.some(q => q.id === p.id)), ...videos],
        projects: [...this.catalog.projects.filter(p => !projects.some(q => q.id === p.id)), ...projects]
      });
      committed = true;
    } finally {
      if (!committed) for (const target of moved) await fs.rm(target, { force: true });
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
}

async function extractArchive(source: string, directory: string, signal: AbortSignal, progress: Progress) {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(source, { lazyEntries: true, autoClose: true }, (error, value) => error ? reject(error) : resolve(value!)));
  await new Promise<void>((resolve, reject) => {
    let count = 0, expanded = 0, actual = 0, processing = false, finished = false;
    const names = new Set<string>();
    const abort = () => { if (processing) zip.close(); else fail(new Error('Import cancelled.')); };
    const fail = (error: Error) => {
      if (finished) return;
      finished = true; zip.close(); signal.removeEventListener('abort', abort); reject(error);
    };
    signal.addEventListener('abort', abort, { once: true });
    zip.on('error', fail);
    zip.on('end', () => { finished = true; signal.removeEventListener('abort', abort); resolve(); });
    zip.on('entry', async entry => {
      processing = true;
      try {
        signal.throwIfAborted();
        const name = entry.fileName;
        if (!safeArchivePath(name) || names.has(name.toLowerCase()) ||
          (name !== 'catalog.json' && !/^media\/[a-f0-9-]+\.(mp4|webm)$/.test(name)) ||
          ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000)
          throw new Error('Unsafe or unexpected archive entry.');
        names.add(name.toLowerCase()); count++; expanded += entry.uncompressedSize;
        if (count > MAX_ENTRIES || expanded > MAX_BYTES || (name === 'catalog.json' && entry.uncompressedSize > MAX_JSON))
          throw new Error('Archive exceeds import limits (32 GiB, 20,000 entries, 16 MiB catalog).');
        const target = path.join(directory, ...name.split('/'));
        await fs.mkdir(path.dirname(target), { recursive: true });
        const stream = await new Promise<NodeJS.ReadableStream>((res, rej) => zip.openReadStream(entry, (error, value) => error ? rej(error) : res(value!)));
        let entryBytes = 0;
        const meter = new Transform({ transform(chunk, _encoding, callback) {
          actual += chunk.length; entryBytes += chunk.length;
          if (actual > MAX_BYTES || (name === 'catalog.json' && entryBytes > MAX_JSON)) callback(new Error('Expanded archive exceeds limits.'));
          else callback(null, chunk);
        } });
        progress(`Importing archive: ${count} files`);
        await pipeline(stream, meter, createWriteStream(target, { flags: 'wx' }), { signal });
        signal.throwIfAborted();
        processing = false;
        zip.readEntry();
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
    if (signal.aborted) abort(); else zip.readEntry();
  });
}
