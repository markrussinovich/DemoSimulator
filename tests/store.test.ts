import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import * as yazl from 'yazl';
import { Store, safeArchivePath } from '../src/main/store';
import { catalogSchema, parseCatalog, type Video, type Catalog } from '../src/shared/model';

const roots: string[] = [];
async function workspace() {
  const root = await fs.mkdtemp(path.join(process.cwd(), 'test-workspace-'));
  roots.push(root); return { root, store: await Store.open(root) };
}
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function video(store: Store): Promise<Video> {
  const source = path.join(store.path, 'source.mp4');
  await fs.writeFile(source, 'test-media-bytes');
  const media = await store.importMedia(source, new AbortController().signal, () => {});
  return { id: randomUUID(), name: 'Demo video', media: media.media, duration: 5, width: 640, height: 360, cues: [{ id: randomUUID(), name: 'Pause', time: 1.5 }] };
}
const projectCatalog = (videos: Video[]): Catalog => ({
  version: 2, videos, projects: [{ id: randomUUID(), name: 'Stage demo', videos: videos.map(video => video.id) }]
});
async function archive(file: string, value: unknown, media?: Video) {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(value)), 'catalog.json');
  if (media) zip.addBuffer(Buffer.from('test-media-bytes'), `media/${media.media}`);
  const writing = pipeline(zip.outputStream, createWriteStream(file)); zip.end(); await writing;
}
describe('multi-video project documents', () => {
  it('round-trips an ordered project with cues and deduplicated media without its originals', async () => {
    const a = await workspace(), b = await workspace();
    const v = await video(a.store);
    const catalog = projectCatalog([v, { ...v, id: randomUUID(), name: 'Second video' }]);
    catalog.projects[0].videos.reverse();
    await a.store.save(catalog);
    const file = path.join(a.root, 'demo.demosim');
    await a.store.exportBundle(catalog.projects[0].id, file, new AbortController().signal, () => {});
    await fs.rm(path.join(a.root, 'source.mp4'));
    await b.store.importBundle(file, false, new AbortController().signal, () => {});
    const loaded = (await Store.open(b.root)).snapshot().catalog;
    expect(loaded.projects).toEqual(catalog.projects);
    expect(loaded.videos[0].cues).toEqual(v.cues);
    expect(loaded.videos[0].media).toBe(loaded.videos[1].media);
    expect(await fs.readFile(await b.store.mediaPath(loaded.videos[0].media), 'utf8')).toBe('test-media-bytes');
  });
  it('saves and reopens an empty project', async () => {
    const a = await workspace(), b = await workspace(), catalog = projectCatalog([]);
    await a.store.save(catalog);
    const file = path.join(a.root, 'empty.demosim');
    await a.store.exportBundle(catalog.projects[0].id, file, new AbortController().signal, () => {});
    await b.store.importBundle(file, false, new AbortController().signal, () => {});
    expect(b.store.snapshot().catalog).toEqual(catalog);
  });
  it('recovers the prior catalog without replacing its backup with corruption', async () => {
    const a = await workspace(), catalog = projectCatalog([await video(a.store)]);
    await a.store.save(catalog);
    await a.store.save({ ...catalog, projects: [{ ...catalog.projects[0], name: 'Changed' }] });
    await fs.writeFile(path.join(a.root, 'catalog.json'), '{broken');
    const recovered = await Store.open(a.root);
    expect(recovered.snapshot().recovery).toContain('Recovered');
    expect(recovered.snapshot().catalog.projects[0].name).toBe('Stage demo');
    await recovered.save(recovered.snapshot().catalog);
    expect((await Store.open(a.root)).snapshot().catalog.projects[0].name).toBe('Stage demo');
  });
  it('rejects invalid video references and duplicate pause points before changing files', async () => {
    const a = await workspace(), v = await video(a.store), catalog = projectCatalog([v]);
    await a.store.save(catalog);
    await expect(a.store.save({ ...catalog, projects: [{ ...catalog.projects[0], videos: [randomUUID()] }] })).rejects.toThrow();
    expect(catalogSchema.safeParse({ ...catalog, videos: [{ ...v, cues: [v.cues[0], v.cues[0]] }] }).success).toBe(false);
    expect((await Store.open(a.root)).snapshot().catalog).toEqual(catalog);
  });
  it('cleans a cancelled media copy and leaves the original intact', async () => {
    const a = await workspace(), source = path.join(a.root, 'source.mp4');
    await fs.writeFile(source, 'source');
    const c = new AbortController(); c.abort();
    await expect(a.store.importMedia(source, c.signal, () => {})).rejects.toThrow();
    expect(await fs.readdir(path.join(a.root, 'media'))).toEqual([]);
    expect(await fs.readFile(source, 'utf8')).toBe('source');
  });
  it('rejects unexpected archive entries without registering documents', async () => {
    const a = await workspace(), file = path.join(a.root, 'bad.demosim');
    const zip = new yazl.ZipFile(); zip.addBuffer(Buffer.from('bad'), 'unexpected.exe');
    const writing = pipeline(zip.outputStream, createWriteStream(file)); zip.end(); await writing;
    await expect(a.store.importBundle(file, true, new AbortController().signal, () => {})).rejects.toThrow('Unsafe');
    expect(a.store.snapshot().catalog.projects).toEqual([]);
    expect((await fs.readdir(a.root)).filter(name => name.startsWith('import-'))).toEqual([]);
  });
  it('leaves documents and media unchanged when archive references are invalid', async () => {
    const a = await workspace(), file = path.join(a.root, 'broken.demosim');
    await archive(file, { version: 2, videos: [], projects: [{ id: randomUUID(), name: 'Broken', videos: [randomUUID()] }] });
    await expect(a.store.importBundle(file, false, new AbortController().signal, () => {})).rejects.toThrow();
    expect(a.store.snapshot().catalog.projects).toHaveLength(0);
    expect(await fs.readdir(path.join(a.root, 'media'))).toEqual([]);
  });
  it('cleans streamed archive extraction after cancellation', async () => {
    const a = await workspace(), b = await workspace(), catalog = projectCatalog([await video(a.store)]);
    await a.store.save(catalog);
    const file = path.join(a.root, 'cancel.demosim');
    await a.store.exportBundle(catalog.projects[0].id, file, new AbortController().signal, () => {});
    const controller = new AbortController();
    await expect(b.store.importBundle(file, true, controller.signal, () => controller.abort())).rejects.toThrow();
    expect(b.store.snapshot().catalog.projects).toHaveLength(0);
    expect((await fs.readdir(b.root)).filter(name => name.startsWith('import-'))).toEqual([]);
  });
  it('does not overwrite a saved project when a save is cancelled', async () => {
    const a = await workspace(), catalog = projectCatalog([await video(a.store)]);
    await a.store.save(catalog);
    const file = path.join(a.root, 'cancel-save.demosim'); await fs.writeFile(file, 'previous project');
    const controller = new AbortController(); controller.abort();
    await expect(a.store.exportBundle(catalog.projects[0].id, file, controller.signal, () => {})).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe('previous project');
    expect((await fs.readdir(a.root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
});
describe('previous-version migration', () => {
  it('turns playlists into projects preserving order/repeats and retains standalone videos', async () => {
    const a = await workspace(), v = await video(a.store), other = { ...v, id: randomUUID(), name: 'Other' };
    const standalone = { ...v, id: randomUUID(), name: 'Standalone' };
    const list = { id: randomUUID(), name: 'Demo sequence', projects: [other.id, v.id, other.id] };
    const old = { version: 1, projects: [v, other, standalone], playlists: [list] };
    const migrated = parseCatalog(old);
    expect(migrated.version).toBe(2);
    expect(migrated.projects).toEqual([
      { id: list.id, name: list.name, videos: list.projects },
      { id: standalone.id, name: standalone.name, videos: [standalone.id] }
    ]);
    const file = path.join(a.root, 'old.demosim');
    await archive(file, old, v);
    const b = await workspace();
    await b.store.importBundle(file, false, new AbortController().signal, () => {});
    expect(b.store.snapshot().catalog.projects).toEqual(migrated.projects);
    expect(b.store.snapshot().catalog.videos[0].cues).toEqual(v.cues);
  });
  it('reads legacy folders without rewriting their original catalog', async () => {
    const a = await workspace(), v = await video(a.store);
    const old = { version: 1, projects: [v], playlists: [] };
    const source = JSON.stringify(old);
    await fs.writeFile(path.join(a.root, 'catalog.json'), source);
    const loaded = await Store.open(a.root);
    expect(loaded.snapshot().catalog.projects[0].videos).toEqual([v.id]);
    expect(await fs.readFile(path.join(a.root, 'catalog.json'), 'utf8')).toBe(source);
  });
  it('does not silently migrate missing video references or duplicate documents', () => {
    expect(() => parseCatalog({ version: 1, projects: [], playlists: [{ id: randomUUID(), name: 'Broken', projects: [randomUUID()] }] })).toThrow();
  });
});
it('rejects traversal, Windows aliases and ambiguous paths', () => {
  for (const name of ['../catalog.json', 'C:/file', '//server/file', 'media\\file', 'media/NUL.mp4', 'media/foo. ', 'media/a:b', 'media/./file'])
    expect(safeArchivePath(name)).toBe(false);
  expect(safeArchivePath('media/abc-123.mp4')).toBe(true);
});
