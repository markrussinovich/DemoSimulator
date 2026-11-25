import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from '../../src/main/store';
import type { Video } from '../../src/shared/model';

let app: ElectronApplication, page: Page, root: string;
async function launchApp() {
  const packaged = process.env.DEMOSIM_PACKAGED === '1';
  app = await electron.launch({
    executablePath: packaged ? process.env.DEMOSIM_EXECUTABLE ?? path.join(process.cwd(), 'release', 'win-unpacked', 'Demo Simulator.exe') : undefined,
    args: [...(packaged ? [] : ['.']), `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd()
  });
  page = await app.firstWindow();
  page.on('dialog', async dialog => { if (dialog.type() !== 'beforeunload') await dialog.accept(); });
  await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeEnabled();
}
test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(process.cwd(), 'test-e2e-regression-'));
  await launchApp();
});
test.afterEach(async () => {
  if (app) {
    await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; });
    await app.close();
  }
  if (root) await fs.rm(root, { recursive: true, force: true });
});
async function saveTo(file: string) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, file);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.save-status')).toContainText('Saved');
  await expect(page.locator('.notice[role="status"]')).toHaveCount(0);
}
async function importPlaybackVideo() {
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, path.join(process.cwd(), 'tests', 'e2e', 'playback.webm'));
  await page.getByRole('button', { name: 'Add video', exact: true }).click();
  await expect(page.getByLabel('Video name', { exact: true })).toHaveValue('playback');
  await expect(page.locator('.preview')).toHaveJSProperty('readyState', 4);
}
for (const outcome of ['project', 'empty', 'error'] as const) {
test(`startup hides the empty-project screen until restoration resolves (${outcome})`, async () => {
  if (outcome === 'project') {
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await page.getByLabel('Project name', { exact: true }).fill('Restored startup project');
    await saveTo(path.join(root, 'startup.demosim'));
  }
  const workspace = await page.evaluate(() => window.demo.currentProject());
  await app.evaluate(({ ipcMain }, { workspace, fail }) => {
    ipcMain.removeHandler('project:current');
    ipcMain.handle('project:current', () => new Promise((resolve, reject) => {
      ipcMain.once('test:restore-ready', () => {
        if (fail) reject(new Error('Startup restore failed.'));
        else resolve(workspace);
      });
    }));
  }, { workspace, fail: outcome === 'error' });
  await page.reload();
  await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeDisabled();
  await expect(page.locator('.notice[role="status"]')).toContainText('Loading...');
  await expect(page.locator('.welcome')).toHaveCount(0);
  await expect(page.getByLabel('Project name', { exact: true })).toHaveCount(0);
  await app.evaluate(({ ipcMain }) => ipcMain.emit('test:restore-ready'));
  await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeEnabled();
  await expect(page.locator('.notice[role="status"]')).toHaveCount(0);
  if (outcome === 'project') {
    await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('Restored startup project');
    await expect(page.locator('.welcome')).toHaveCount(0);
  } else {
    await expect(page.locator('.welcome')).toBeVisible();
    if (outcome === 'error') await expect(page.getByRole('alert')).toContainText('Startup restore failed.');
  }
});
}
test('deleting an unsaved project supports cancellation and stays deleted after restart', async () => {
  const files = page.getByRole('navigation', { name: 'Project files', exact: true });
  const deleteButton = files.getByRole('button', { name: 'Delete project', exact: true });
  await expect(deleteButton).toBeDisabled();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(deleteButton).toBeEnabled();
  expect(await deleteButton.evaluate(element => ({
    previous: element.previousElementSibling?.textContent,
    next: element.nextElementSibling?.getAttribute('aria-label')
  }))).toEqual({ previous: 'Save as...', next: 'Help' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 600));
  expect(await page.locator('.app-header').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.getByLabel('Project name', { exact: true }).fill('');
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });
  await page.getByRole('button', { name: 'Delete project', exact: true }).click();
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Delete project', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.demo.currentProject())).not.toBeNull();
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await page.getByRole('button', { name: 'Delete project', exact: true }).click();
  await expect(page.locator('.welcome')).toBeVisible();
  expect(await page.evaluate(() => window.demo.currentProject())).toBeNull();
  await app.close();
  await launchApp();
  await expect(page.locator('.welcome')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete project', exact: true })).toBeDisabled();
});
test('deleting a saved project uses the Recycle Bin and preserves edits when recycling fails', async () => {
  await importPlaybackVideo();
  const recording = path.join(process.cwd(), 'tests', 'e2e', 'playback.webm');
  const original = await fs.readFile(recording);
  const file = path.join(root, 'delete-me.demosim');
  await saveTo(file);
  const saved = await fs.readFile(file);
  await page.getByLabel('Project name', { exact: true }).fill('Unsaved project edits');
  await app.evaluate(({ dialog, shell }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    shell.trashItem = async () => { throw new Error('Recycle Bin is unavailable.'); };
  });
  await page.getByRole('button', { name: 'Delete project', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Recycle Bin is unavailable.');
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('Unsaved project edits');
  expect((await page.evaluate(() => window.demo.currentProject()))!.filePath).toBe(file);
  expect(await fs.readFile(file)).toEqual(saved);
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await app.evaluate(({ shell }) => {
    shell.trashItem = async file => {
      (globalThis as typeof globalThis & { trashedProject?: string }).trashedProject = file;
    };
  });
  await page.getByRole('button', { name: 'Delete project', exact: true }).click();
  await expect(page.locator('.welcome')).toBeVisible();
  expect(await app.evaluate(() => (globalThis as typeof globalThis & { trashedProject?: string }).trashedProject)).toBe(file);
  expect(await fs.readFile(recording)).toEqual(original);
});
test('deleting a recovered project preserves other projects, their edits, shared media, and saved files', async () => {
  const source = await Store.open(path.join(root, 'legacy-delete'));
  const media = await source.importMedia(path.join(process.cwd(), 'tests', 'e2e', 'playback.webm'), new AbortController().signal, () => {});
  const video: Video = { id: randomUUID(), name: 'Shared recording', media: media.media, duration: 5, width: 320, height: 180, cues: [] };
  const projects = [
    { id: randomUUID(), name: 'Keep this project', videos: [video.id] },
    { id: randomUUID(), name: 'Delete this project', videos: [video.id] }
  ];
  await source.save({ version: 2, videos: [video], projects });
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, source.path);
  await page.getByRole('button', { name: 'Open a previous-version workspace...', exact: true }).click();
  const file = path.join(root, 'keep.demosim');
  await saveTo(file);
  const saved = await fs.readFile(file);
  await page.getByLabel('Project name', { exact: true }).fill('Edited remaining project');
  await page.getByLabel('Recovered project', { exact: true }).selectOption(projects[1].id);
  await app.evaluate(({ dialog, shell }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    shell.trashItem = async () => { throw new Error('Must not recycle another project file.'); };
  });
  await page.getByRole('button', { name: 'Delete project', exact: true }).click();
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('Edited remaining project');
  await expect(page.getByLabel('Video name', { exact: true })).toHaveValue(video.name);
  await expect(page.locator('.preview')).toHaveJSProperty('readyState', 4);
  await expect(page.locator('.save-status')).toContainText('Unsaved changes');
  const current = await page.evaluate(() => window.demo.currentProject());
  expect(current!.catalog.projects).toEqual([{ ...projects[0], name: 'Edited remaining project' }]);
  expect(current!.catalog.videos).toEqual([expect.objectContaining({ id: video.id })]);
  expect(await fs.readFile(file)).toEqual(saved);
  expect((await Store.open(source.path)).snapshot().catalog.projects).toEqual(projects);
});
test('saving another recovered project prompts for its own file and cannot overwrite the first', async () => {
  const source = await Store.open(path.join(root, 'legacy'));
  const projects = [
    { id: randomUUID(), name: 'First recovered project', videos: [] },
    { id: randomUUID(), name: 'Second recovered project', videos: [] }
  ];
  await source.save({ version: 2, videos: [], projects });
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, source.path);
  await page.getByRole('button', { name: 'Open a previous-version workspace...', exact: true }).click();
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue(projects[0].name);
  const firstFile = path.join(root, 'first.demosim');
  await saveTo(firstFile);
  const original = createHash('sha256').update(await fs.readFile(firstFile)).digest('hex');
  await page.getByLabel('Recovered project', { exact: true }).selectOption(projects[1].id);
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined });
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.notice[role="status"]')).toHaveCount(0);
  await expect(page.locator('.save-status')).toContainText('Unsaved changes');
  expect(createHash('sha256').update(await fs.readFile(firstFile)).digest('hex')).toBe(original);
  const secondFile = path.join(root, 'second.demosim');
  await saveTo(secondFile);
  expect(createHash('sha256').update(await fs.readFile(firstFile)).digest('hex')).toBe(original);
  const reopened = await Store.open(path.join(root, 'reopened'));
  await reopened.importBundle(secondFile, false, new AbortController().signal, () => {});
  expect(reopened.snapshot().catalog.projects).toEqual([projects[1]]);
});
test('removing an invalid video allows saving while preserving repeated and shared videos', async () => {
  const source = await Store.open(path.join(root, 'workspace'));
  const file = path.join(root, 'source.webm');
  await fs.writeFile(file, 'placeholder media: decoding is not needed for this document test');
  const media = await source.importMedia(file, new AbortController().signal, () => {});
  const video: Video = { id: randomUUID(), name: 'Shared video', media: media.media, duration: 5, width: 320, height: 180, cues: [] };
  const disposable = { ...video, id: randomUUID(), name: 'Disposable video' };
  const projects = [
    { id: randomUUID(), name: 'Active project', videos: [disposable.id, video.id, video.id] },
    { id: randomUUID(), name: 'Other project', videos: [video.id] }
  ];
  await source.save({ version: 2, videos: [disposable, video], projects });
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, source.path);
  await page.getByRole('button', { name: 'Open a previous-version workspace...', exact: true }).click();
  await expect(page.getByLabel('Video name', { exact: true })).toHaveValue(disposable.name);
  await page.getByLabel('Video name', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Remove video', exact: true }).click();
  await expect(page.locator('.video-list li')).toHaveCount(2);
  await page.getByRole('button', { name: 'Remove video', exact: true }).click();
  await expect(page.locator('.video-list li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove video', exact: true }).click();
  await expect(page.locator('.video-list li')).toHaveCount(0);
  await saveTo(path.join(root, 'empty-active.demosim'));
  const current = await page.evaluate(() => window.demo.currentProject());
  expect(current!.catalog.videos).toEqual([expect.objectContaining({ id: video.id })]);
  await page.getByLabel('Recovered project', { exact: true }).selectOption(projects[1].id);
  await expect(page.getByLabel('Video name', { exact: true })).toHaveValue(video.name);
});
test('presentation error buttons support native Enter and Space activation', async () => {
  const source = await Store.open(path.join(root, 'broken-media'));
  const file = path.join(root, 'broken.mp4');
  await fs.writeFile(file, 'invalid video');
  const media = await source.importMedia(file, new AbortController().signal, () => {});
  const video: Video = { id: randomUUID(), name: 'Broken recording', media: media.media, duration: 5, width: 320, height: 180, cues: [] };
  await source.save({ version: 2, videos: [video], projects: [{ id: randomUUID(), name: 'Playback error', videos: [video.id] }] });
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, source.path);
  await page.getByRole('button', { name: 'Open a previous-version workspace...', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.getByLabel('Fullscreen presentation').uncheck();
  await page.getByRole('button', { name: 'Play this video', exact: true }).click();
  await expect(page.getByTestId('stage')).toHaveAttribute('data-state', 'error');
  await page.locator('.stage video').evaluate(element => {
    element.dataset.reloads = '0';
    element.addEventListener('loadstart', () => { element.dataset.reloads = String(Number(element.dataset.reloads) + 1); });
  });
  await page.getByRole('button', { name: 'Restart', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.stage video')).toHaveAttribute('data-reloads', '1');
  await expect(page.getByTestId('stage')).toHaveAttribute('data-state', 'error');
  await page.getByRole('button', { name: 'Return to editor', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('stage')).toHaveCount(0);
});
test('timeline uses normal cursors and seeking recovers after repeated drags and file operations', async () => {
  const source = await Store.open(path.join(root, 'timeline'));
  const file = path.join(root, 'timeline.mp4');
  await fs.writeFile(file, 'placeholder media: decoding is not needed for this pointer test');
  const media = await source.importMedia(file, new AbortController().signal, () => {});
  const video: Video = { id: randomUUID(), name: 'Timeline cursors', media: media.media, duration: 5, width: 320, height: 180, cues: [] };
  await source.save({ version: 2, videos: [video], projects: [{ id: randomUUID(), name: 'Timeline', videos: [video.id] }] });
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, source.path);
  await page.getByRole('button', { name: 'Open a previous-version workspace...', exact: true }).click();
  const timeline = page.getByTestId('timeline'), playhead = page.getByRole('slider', { name: 'Video position', exact: true });
  const preview = page.locator('.preview');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(timeline).toHaveCSS('cursor', 'default');
  await expect(playhead).toHaveCSS('cursor', 'default');
  const duration = Number(await playhead.getAttribute('aria-valuemax'));
  const timeAt = (fraction: number) => Math.round(duration * fraction * 1000) / 1000;
  const track = (await timeline.boundingBox())!;
  await timeline.evaluate(element => element.addEventListener('pointerdown', event => { element.dataset.pointer = String(event.pointerId); }));
  await page.mouse.click(track.x + track.width * .3, track.y + 30);
  await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(timeAt(.3), 3);
  for (const fraction of [.6, .2, .8, .6]) {
    const marker = (await playhead.boundingBox())!;
    await page.mouse.move(marker.x + marker.width / 2, marker.y + marker.height / 2);
    await page.mouse.down();
    await expect(timeline).toHaveCSS('cursor', 'default');
    await page.mouse.move(track.x + track.width * fraction, track.y + 30, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(timeAt(fraction), 3);
    expect(await timeline.evaluate(element => element.hasPointerCapture(Number(element.dataset.pointer)))).toBe(false);
  }
  await expect(playhead).toHaveCSS('cursor', 'default');
  const moved = (await playhead.boundingBox())!;
  await page.mouse.move(moved.x + moved.width / 2, moved.y + moved.height / 2);
  await page.mouse.down();
  await timeline.dispatchEvent('pointercancel', { pointerId: Number(await timeline.getAttribute('data-pointer')) });
  expect(await timeline.evaluate(element => element.hasPointerCapture(Number(element.dataset.pointer)))).toBe(false);
  await page.mouse.up();
  await page.mouse.click(track.x + track.width * .4, track.y + 30);
  await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(timeAt(.4), 3);
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = () => new Promise(resolve => {
      (globalThis as typeof globalThis & { finishSaveDialog?: () => void }).finishSaveDialog = () => resolve({ canceled: true, filePath: undefined });
    });
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(playhead).toHaveAttribute('aria-disabled', 'true');
  await page.mouse.dblclick(track.x + track.width * .7, track.y + 30);
  await expect(page.locator('.pause-marker')).toHaveCount(0);
  await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(timeAt(.4), 3);
  await app.evaluate(() => {
    const pending = globalThis as typeof globalThis & { finishSaveDialog?: () => void };
    pending.finishSaveDialog!(); delete pending.finishSaveDialog;
  });
  await expect(playhead).toHaveAttribute('aria-disabled', 'false');
  await page.mouse.click(track.x + track.width * .7, track.y + 30);
  await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(timeAt(.7), 3);
});
test('double-clicking the timeline adds and selects pause points without duplicating markers', async () => {
  await importPlaybackVideo();
  const timeline = page.getByTestId('timeline'), track = (await timeline.boundingBox())!;
  const firstX = Math.round(track.x + track.width * .3), secondX = Math.round(track.x + track.width * .6);
  const timeAt = (x: number) => Math.round((x - track.x) / track.width * 5000) / 1000;
  await page.mouse.click(track.x + track.width * .2, track.y + 30);
  await expect(page.locator('.pause-marker')).toHaveCount(0);
  await page.mouse.dblclick(firstX, track.y + 30);
  await expect(page.locator('.pause-marker')).toHaveCount(1);
  await expect(page.getByLabel('Pause time', { exact: true })).toHaveValue(String(timeAt(firstX)));
  await expect(page.locator('.pause-marker')).toHaveClass(/selected/);
  await page.locator('.pause-marker').dblclick();
  await expect(page.locator('.pause-marker')).toHaveCount(1);
  await page.mouse.dblclick(secondX, track.y + 30);
  await expect(page.locator('.pause-marker')).toHaveCount(2);
  await expect(page.getByLabel('Pause time', { exact: true })).toHaveValue(String(timeAt(secondX)));
  await page.mouse.dblclick(secondX, track.y + 30);
  await expect(page.locator('.pause-marker')).toHaveCount(2);
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await saveTo(path.join(root, 'double-click.demosim'));
  const current = await page.evaluate(() => window.demo.currentProject());
  expect(current!.catalog.videos[0].cues.map(cue => cue.time)).toEqual([timeAt(firstX), timeAt(secondX)]);
});
test('presentation keeps the cursor hidden over video even while paused or a panel is open', async () => {
  await importPlaybackVideo();
  const preview = page.locator('.preview');
  await preview.evaluate((video: HTMLVideoElement) => { video.currentTime = 2; });
  await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.currentTime)).toBe(2);
  await page.getByRole('button', { name: 'Add pause point', exact: true }).click();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByLabel('Fullscreen presentation').uncheck();
  await page.getByRole('button', { name: 'Play this video', exact: true }).click();
  const stage = page.getByTestId('stage'), video = page.locator('.stage video');
  await expect(stage).toHaveAttribute('data-state', 'ready');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].focus(); BrowserWindow.getAllWindows()[0].webContents.focus(); });
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  await expect(video).toHaveCSS('cursor', 'none');
  await page.keyboard.press('Space');
  await expect(stage).toHaveAttribute('data-state', 'playing');
  await expect(video).toHaveCSS('cursor', 'none');
  await page.keyboard.press('Space');
  await expect(stage).toHaveAttribute('data-state', 'manually-paused');
  await expect(video).toHaveCSS('cursor', 'none');
  await page.keyboard.press('Space');
  await expect(stage).toHaveAttribute('data-state', 'cue-paused');
  await expect(video).toHaveCSS('cursor', 'none');
  await page.keyboard.press('Control+Space');
  const drawer = page.getByRole('region', { name: 'Playback controls', exact: true });
  await expect(drawer).toHaveCSS('cursor', 'default');
  await expect(drawer.getByRole('slider')).toHaveCSS('cursor', 'default');
  await expect(drawer.getByRole('button', { name: 'Play', exact: true })).toHaveCSS('cursor', 'pointer');
  await expect(video).toHaveCSS('cursor', 'none');
  await page.keyboard.press('Control+Space');
  await page.keyboard.press('Enter');
  await expect(stage).toHaveAttribute('data-state', 'playing');
  await expect(video).toHaveCSS('cursor', 'none');
  await page.keyboard.press('Escape');
  await expect(page.locator('.preview')).toHaveCSS('cursor', 'auto');
});
test('presenter notes toggle beside the video, stay separate across videos, and are hidden by default in presentation', async () => {
  await importPlaybackVideo();
  const toggle = page.getByRole('button', { name: 'Presenter notes', exact: true });
  const notes = page.getByRole('textbox', { name: 'Presenter notes', exact: true });
  const firstNotes = 'Opening talking points\nExplain the architecture.';
  const secondNotes = 'Different video, different talking points.';
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(notes).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await notes.fill(firstNotes);
  await page.getByRole('button', { name: 'Close presenter notes', exact: true }).click();
  await expect(notes).toHaveCount(0);
  await toggle.click();
  await expect(notes).toHaveValue(firstNotes);
  await page.locator('.preview').evaluate((video: HTMLVideoElement) => { video.currentTime = 1; });
  await page.getByRole('button', { name: 'Add pause point', exact: true }).click();
  await expect(page.getByLabel('Use video default', { exact: true })).toBeChecked();
  for (const [width, height] of [[900, 560], [1280, 760]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    const playButton = (await page.getByRole('button', { name: 'Play this video', exact: true }).boundingBox())!;
    const videoName = (await page.getByLabel('Video name', { exact: true }).boundingBox())!;
    expect(playButton.x + playButton.width).toBeLessThanOrEqual(videoName.x);
    const geometry = await page.evaluate(() => {
      const preview = document.querySelector('.preview-area')!.getBoundingClientRect();
      const panel = document.querySelector('.presenter-notes')!.getBoundingClientRect();
      return {
        beside: panel.left >= preview.right && Math.abs(panel.top - preview.top) < 1,
        clipped: ['.preview-area', '.presenter-notes', '.presenter-notes textarea', '.timeline-panel', '.transport', '.cue-inspector', 'footer'].some(selector => {
          const rect = document.querySelector(selector)!.getBoundingClientRect();
          return rect.bottom > innerHeight + 1 || rect.top < 0 || rect.right > innerWidth + 1 || rect.left < 0 || rect.height <= 0;
        }),
        overflow: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth
      };
    });
    expect(geometry).toEqual({ beside: true, clipped: false, overflow: false });
  }
  await page.getByRole('button', { name: 'Add video', exact: true }).click();
  await expect(page.locator('.video-list li')).toHaveCount(2);
  await expect(notes).toHaveValue('');
  await notes.fill(secondNotes);
  await page.locator('.video-list li').first().getByRole('button').click();
  await expect(notes).toHaveValue(firstNotes);
  const file = path.join(root, 'video-notes.demosim');
  await saveTo(file);
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, file);
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(notes).toHaveValue(firstNotes);
  await page.locator('.video-list li').last().getByRole('button').click();
  await expect(notes).toHaveValue(secondNotes);
  await page.getByLabel('Fullscreen presentation').uncheck();
  await page.getByRole('button', { name: 'Play this video', exact: true }).click();
  await expect(page.getByTestId('stage')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('complementary', { name: 'Presenter notes', exact: true })).toHaveCount(0);
  await expect(notes).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(notes).toHaveValue(secondNotes);
});
test('pause notes inherit video defaults, customize on typing, and reset to inherited notes', async () => {
  await importPlaybackVideo();
  for (const time of [1, 2]) {
    await page.locator('.preview').evaluate((video: HTMLVideoElement, time) => { video.currentTime = time; }, time);
    await page.getByRole('button', { name: 'Add pause point', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Presenter notes', exact: true }).click();
  const scope = page.getByLabel('Notes for', { exact: true });
  const notes = page.getByRole('textbox', { name: 'Presenter notes', exact: true });
  const inherit = page.getByLabel('Use video default', { exact: true });
  await scope.selectOption('');
  await notes.fill('Shared talking points.');
  await scope.selectOption({ label: '1. Pause 1' });
  await expect(inherit).toBeChecked();
  await expect(notes).toHaveValue('Shared talking points.');
  await notes.fill('Explain this pause differently.\nKeep this line break.');
  await expect(inherit).not.toBeChecked();
  await expect(page.getByLabel('Pause time', { exact: true })).toHaveValue('1');
  await scope.selectOption('');
  await notes.fill('Updated default talking points.');
  await scope.selectOption({ label: '1. Pause 1' });
  await expect(notes).toHaveValue('Explain this pause differently.\nKeep this line break.');
  await scope.selectOption({ label: '2. Pause 2' });
  await expect(inherit).toBeChecked();
  await expect(notes).toHaveValue('Updated default talking points.');
  await notes.fill('');
  await expect(inherit).not.toBeChecked();
  await inherit.check();
  await expect(notes).toHaveValue('Updated default talking points.');
  const file = path.join(root, 'pause-notes.demosim');
  await saveTo(file);
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, file);
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await scope.selectOption({ label: '1. Pause 1' });
  await expect(inherit).not.toBeChecked();
  await expect(notes).toHaveValue('Explain this pause differently.\nKeep this line break.');
  await scope.selectOption({ label: '2. Pause 2' });
  await expect(inherit).toBeChecked();
  await expect(notes).toHaveValue('Updated default talking points.');
});
test('notes follow the latest reached pause when scrubbing backward, forward, and playing the preview', async () => {
  await importPlaybackVideo();
  for (const time of [1, 2]) {
    await page.locator('.preview').evaluate((video: HTMLVideoElement, time) => { video.currentTime = time; }, time);
    await page.getByRole('button', { name: 'Add pause point', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Presenter notes', exact: true }).click();
  const scope = page.getByLabel('Notes for', { exact: true });
  const notes = page.getByRole('textbox', { name: 'Presenter notes', exact: true });
  await scope.selectOption('');
  await notes.fill('Video default notes.');
  const [firstId] = await scope.selectOption({ label: '1. Pause 1' });
  await notes.fill('First pause notes.');
  const [secondId] = await scope.selectOption({ label: '2. Pause 2' });
  await notes.fill('Second pause notes.');
  const track = (await page.getByTestId('timeline').boundingBox())!;
  for (const [fraction, expected, id] of [
    [.1, 'Video default notes.', ''], [.3, 'First pause notes.', firstId],
    [.5, 'Second pause notes.', secondId], [.3, 'First pause notes.', firstId], [.1, 'Video default notes.', '']
  ] as const) {
    await page.mouse.click(track.x + track.width * fraction, track.y + 30);
    await expect(notes).toHaveValue(expected);
    await expect(scope).toHaveValue(id);
  }
  const marker = (await page.getByRole('slider', { name: 'Video position', exact: true }).boundingBox())!;
  await page.mouse.move(marker.x + marker.width / 2, marker.y + marker.height / 2);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width * .3, track.y + 30);
  await expect(notes).toHaveValue('First pause notes.');
  await page.mouse.move(track.x + track.width * .5, track.y + 30);
  await expect(notes).toHaveValue('Second pause notes.');
  await page.mouse.up();
  await page.mouse.click(track.x + track.width * .3, track.y + 30);
  await notes.fill('Edited first pause after scrubbing.');
  await scope.selectOption('');
  await expect(notes).toHaveValue('Video default notes.');
  const playhead = page.getByRole('slider', { name: 'Video position', exact: true });
  await playhead.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(notes).toHaveValue('Edited first pause after scrubbing.');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(notes).toHaveValue('Second pause notes.');
  await page.getByRole('button', { name: 'Previous frame', exact: true }).click();
  await expect(notes).toHaveValue('Edited first pause after scrubbing.');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(notes).toHaveValue('Video default notes.');
  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
  await expect(notes).toHaveValue('Edited first pause after scrubbing.');
  await expect(page.locator('.preview')).toHaveJSProperty('paused', true);
  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
  await expect(notes).toHaveValue('Second pause notes.');
});
test('notes keep fixed spacing, resize within bounds, and remember width across application runs', async () => {
  await importPlaybackVideo();
  await page.locator('.preview').evaluate((video: HTMLVideoElement) => { video.currentTime = 1; });
  await page.getByRole('button', { name: 'Add pause point', exact: true }).click();
  await page.getByRole('button', { name: 'Presenter notes', exact: true }).click();
  const scope = page.getByLabel('Notes for', { exact: true });
  const notes = page.getByRole('textbox', { name: 'Presenter notes', exact: true });
  const pauseTop = (await notes.boundingBox())!.y;
  await scope.selectOption('');
  expect((await notes.boundingBox())!.y).toBe(pauseTop);
  const panel = page.getByRole('complementary', { name: 'Presenter notes', exact: true });
  const divider = page.getByRole('separator', { name: 'Resize presenter notes' });
  const originalWidth = (await panel.boundingBox())!.width;
  const handle = (await divider.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - 96, handle.y + handle.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await panel.boundingBox())!.width).toBe(originalWidth + 96);
  await divider.press('ArrowLeft');
  const rememberedWidth = originalWidth + 112;
  await expect.poll(async () => (await panel.boundingBox())!.width).toBe(rememberedWidth);
  const file = path.join(root, 'notes-width.demosim');
  await saveTo(file);
  await app.close();
  await launchApp();
  await expect(page.getByLabel('Video name', { exact: true })).toHaveValue('playback');
  await page.getByRole('button', { name: 'Presenter notes', exact: true }).click();
  const reopened = page.getByRole('complementary', { name: 'Presenter notes', exact: true });
  await expect.poll(async () => (await reopened.boundingBox())!.width).toBe(rememberedWidth);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 560));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(900);
  const reopenedDivider = page.getByRole('separator', { name: 'Resize presenter notes' });
  await reopenedDivider.press('End');
  const geometry = await page.evaluate(() => ({
    preview: document.querySelector('.preview-area')!.getBoundingClientRect().width,
    panelRight: document.querySelector('.presenter-notes')!.getBoundingClientRect().right,
    overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight
  }));
  expect(geometry.preview).toBeGreaterThanOrEqual(160);
  expect(geometry.panelRight).toBeLessThanOrEqual(900);
  expect(geometry.overflow).toBe(false);
  await reopenedDivider.press('Home');
  await expect.poll(async () => (await reopened.boundingBox())!.width).toBe(220);
});
for (const fullscreen of [false, true]) {
test(`playback drawer pauses, seeks, navigates pauses, resumes, and restarts the final video (fullscreen: ${fullscreen})`, async () => {
  await importPlaybackVideo();
  for (const time of [1, 3]) {
    await page.locator('.preview').evaluate((video: HTMLVideoElement, time) => { video.currentTime = time; }, time);
    await page.getByRole('button', { name: 'Add pause point', exact: true }).click();
  }
  await page.getByLabel('Fullscreen presentation').setChecked(fullscreen);
  if (!fullscreen) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 560));
  const playedColor = await page.locator('.timeline-fill').evaluate(element => getComputedStyle(element).backgroundColor);
  await page.getByRole('button', { name: 'Play this video', exact: true }).click();
  const stage = page.getByTestId('stage');
  const video = page.locator('.stage video');
  const drawer = page.getByRole('region', { name: 'Playback controls', exact: true });
  await expect(stage).toHaveAttribute('data-state', 'ready');
  await expect(drawer).toHaveCount(0);
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].focus(); BrowserWindow.getAllWindows()[0].webContents.focus(); });
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  await page.keyboard.press('Space');
  await expect(stage).toHaveAttribute('data-state', 'playing');
  await page.keyboard.press('Control+Space');
  await expect(stage).toHaveAttribute('data-state', 'manually-paused');
  await expect(drawer).toBeVisible();
  await expect.poll(() => drawer.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return {
      onscreen: bounds.top >= 0 && bounds.bottom <= innerHeight + 1,
      narrow: bounds.height < 130, fillsWidth: Math.abs(bounds.width - innerWidth) < 1
    };
  })).toEqual({ onscreen: true, narrow: true, fillsWidth: true });
  await expect(video).toHaveJSProperty('paused', true);
  await expect(video).toHaveCSS('cursor', 'none');
  await expect(drawer).toHaveCSS('cursor', 'default');
  for (const name of ['Start of video', 'Previous pause', 'Play']) {
    const button = drawer.getByRole('button', { name, exact: true });
    await expect(button).toHaveText('');
    await expect(button).toHaveAttribute('title', name);
    await expect(button.locator('svg')).toBeVisible();
  }
  await expect(drawer.getByRole('button', { name: /^Seek to pause / })).toHaveCount(2);
  const slider = drawer.getByRole('slider', { name: 'Playback position', exact: true });
  const fill = drawer.locator('.timeline-fill');
  await expect(fill).toHaveCSS('background-color', playedColor);
  const expectPlayedTrack = () => expect.poll(() => fill.evaluate(element => {
    const rail = element.parentElement!.querySelector('.timeline-rail')!;
    const input = element.parentElement!.querySelector('input')!;
    return Math.abs(element.getBoundingClientRect().width - rail.getBoundingClientRect().width * Number(input.value) / Number(input.max));
  })).toBeLessThan(1);
  await expectPlayedTrack();
  await drawer.getByRole('button', { name: 'Seek to pause 2: Pause 2', exact: true }).click();
  await expect(stage).toHaveAttribute('data-state', 'manually-paused');
  await expect(video).toHaveJSProperty('currentTime', 3);
  await expectPlayedTrack();
  await drawer.getByRole('button', { name: 'Previous pause', exact: true }).click();
  await expect(video).toHaveJSProperty('currentTime', 1);
  await expectPlayedTrack();
  await drawer.getByRole('button', { name: 'Previous pause', exact: true }).click();
  await expect(video).toHaveJSProperty('currentTime', 0);
  await expectPlayedTrack();
  const track = (await slider.boundingBox())!;
  await page.mouse.move(track.x + track.width * .1, track.y + track.height / 2);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width / 2, track.y + track.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(2);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeLessThan(3);
  await expectPlayedTrack();
  await drawer.getByRole('button', { name: 'Previous pause', exact: true }).click();
  await expect(video).toHaveJSProperty('currentTime', 1);
  await drawer.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(stage).toHaveAttribute('data-state', 'playing');
  await expect(drawer).toHaveCount(0);
  await page.keyboard.press('Control+Space');
  await expect(stage).toHaveAttribute('data-state', 'manually-paused');
  await page.keyboard.press('Control+Space');
  await expect(drawer).toHaveCount(0);
  await expect(video).toHaveJSProperty('paused', true);
  await page.keyboard.press('Control+Space');
  await drawer.getByRole('button', { name: 'Start of video', exact: true }).click();
  await page.keyboard.press('Space');
  await expect(drawer).toHaveCount(0);
  await expect(stage).toHaveAttribute('data-state', 'cue-paused');
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => Math.abs(element.currentTime - 1))).toBeLessThan(.001);
  await page.keyboard.press('Control+Space');
  await drawer.getByRole('button', { name: 'Seek to pause 2: Pause 2', exact: true }).click();
  await page.keyboard.press('Space');
  await expect(stage).toHaveAttribute('data-state', 'playlist-ended');
  await page.keyboard.press('Control+Space');
  await expectPlayedTrack();
  await drawer.getByRole('button', { name: 'Start of video', exact: true }).click();
  await expect(stage).toHaveAttribute('data-state', 'manually-paused');
  await expect(stage).toHaveAttribute('data-index', '0');
  await expect(video).toHaveJSProperty('currentTime', 0);
  await drawer.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(stage).toHaveAttribute('data-state', 'playing');
  await expect(drawer).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(stage).toHaveCount(0);
});
}
for (const fullscreen of [false, true]) {
test(`presentation edge dwell opens panels after one second and dismisses without resuming (fullscreen: ${fullscreen})`, async () => {
  await importPlaybackVideo();
  await page.getByRole('button', { name: 'Presenter notes', exact: true }).click();
  await page.getByRole('textbox', { name: 'Presenter notes', exact: true }).fill('Default presentation talking points.');
  await page.getByLabel('Fullscreen presentation').setChecked(fullscreen);
  if (!fullscreen) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 560));
  await page.getByRole('button', { name: 'Play this video', exact: true }).click();
  const stage = page.getByTestId('stage');
  const video = page.locator('.stage video');
  const drawer = page.getByRole('region', { name: 'Playback controls', exact: true });
  const notes = page.getByRole('complementary', { name: 'Presenter notes', exact: true });
  await expect(stage).toHaveAttribute('data-state', 'ready');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].focus(); BrowserWindow.getAllWindows()[0].webContents.focus(); });
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  const { width, height } = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.mouse.move(width / 2, height / 2);
  await page.keyboard.press('Space');
  await expect(stage).toHaveAttribute('data-state', 'playing');
  await page.mouse.move(width / 2, height - 2);
  await page.clock.runFor(600);
  await page.mouse.move(width / 2, height / 2);
  await page.clock.runFor(1000);
  await expect(drawer).toHaveCount(0);
  await expect(stage).toHaveAttribute('data-state', 'playing');
  await page.mouse.move(width / 2, height - 2);
  await page.clock.runFor(999);
  await expect(drawer).toHaveCount(0);
  await page.mouse.move(width / 2 + 20, height - 2);
  await page.clock.runFor(1);
  await expect(drawer).toBeVisible();
  await expect(stage).toHaveAttribute('data-state', 'manually-paused');
  await expect(video).toHaveJSProperty('paused', true);
  await expect(video).toHaveCSS('cursor', 'none');
  await expect(drawer).toHaveCSS('cursor', 'default');
  await page.mouse.move(width / 2, height - 45);
  await page.clock.runFor(1200);
  await expect(drawer).toBeVisible();
  await page.mouse.move(width / 2, height / 2);
  await expect(drawer).toHaveCount(0);
  await expect(stage).toHaveAttribute('data-state', 'manually-paused');
  await page.mouse.move(width - 2, height / 2);
  await page.clock.runFor(999);
  await expect(notes).toHaveCount(0);
  await page.clock.runFor(1);
  await expect(notes).toBeVisible();
  await expect(notes).toHaveCSS('cursor', 'default');
  await expect(video).toHaveCSS('cursor', 'none');
  await expect(notes.getByText('Video default', { exact: true })).toBeVisible();
  await expect(notes.getByText('Default presentation talking points.', { exact: true })).toBeVisible();
  await expect.poll(() => notes.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= innerHeight + 1 && bounds.right <= innerWidth + 1 && Math.abs(bounds.width - 260) < 1;
  })).toBe(true);
  await page.mouse.move(width - 40, height / 2);
  await expect(notes).toBeVisible();
  await page.mouse.move(width / 2, height / 2);
  await expect(notes).toHaveCount(0);
  await expect(video).toHaveJSProperty('paused', true);
  await page.mouse.move(width - 2, height / 2);
  await page.clock.runFor(1000);
  await expect(notes).toBeVisible();
  await page.keyboard.press('Space');
  await expect(stage).toHaveAttribute('data-state', 'playing');
  await expect(notes).toHaveCount(0);
  await page.clock.runFor(1500);
  await expect(notes).toHaveCount(0);
  await page.mouse.move(width / 2, height - 2);
  await page.clock.runFor(500);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.clock.runFor(1000);
  await expect(drawer).toHaveCount(0);
  await expect(stage).toHaveAttribute('data-state', 'focus-paused');
  await page.keyboard.press('Escape');
});
}
test('presentation hover notes follow pause overrides, inherited defaults, and blank notes while keyboard controls stay pinned', async () => {
  await importPlaybackVideo();
  for (const time of [1, 2, 3]) {
    await page.locator('.preview').evaluate((video: HTMLVideoElement, time) => { video.currentTime = time; }, time);
    await page.getByRole('button', { name: 'Add pause point', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Presenter notes', exact: true }).click();
  const scope = page.getByLabel('Notes for', { exact: true });
  const editorNotes = page.getByRole('textbox', { name: 'Presenter notes', exact: true });
  await scope.selectOption('');
  await editorNotes.fill('Inherited talking points.');
  await scope.selectOption({ label: '1. Pause 1' });
  await editorNotes.fill('Custom first-pause talking points.');
  await scope.selectOption({ label: '3. Pause 3' });
  await editorNotes.fill('');
  await page.getByRole('separator', { name: 'Resize presenter notes' }).press('ArrowLeft');
  await page.getByLabel('Fullscreen presentation').uncheck();
  await page.getByRole('button', { name: 'Play this video', exact: true }).click();
  const stage = page.getByTestId('stage');
  const drawer = page.getByRole('region', { name: 'Playback controls', exact: true });
  const notes = page.getByRole('complementary', { name: 'Presenter notes', exact: true });
  await expect(stage).toHaveAttribute('data-state', 'ready');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].focus(); BrowserWindow.getAllWindows()[0].webContents.focus(); });
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  const { width, height } = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  for (const [index, expected] of [[1, 'Custom first-pause talking points.'], [2, 'Inherited talking points.'], [3, 'No notes for this section.']] as const) {
    await page.keyboard.press('Control+Space');
    await page.mouse.move(width / 2, height / 2);
    await page.clock.runFor(1500);
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: `Seek to pause ${index}: Pause ${index}`, exact: true }).click();
    await expect(stage).toHaveAttribute('data-state', 'manually-paused');
    await page.mouse.move(width - 2, height / 2);
    await page.clock.runFor(1000);
    await expect(notes).toBeVisible();
    await expect(drawer).toHaveCount(0);
    await expect(notes.getByText(`${index}. Pause ${index}`, { exact: true })).toBeVisible();
    await expect(notes.getByText(expected, { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect.poll(async () => (await notes.boundingBox())!.width).toBe(276);
    if (index < 3) {
      await notes.getByRole('button', { name: 'Close presenter notes', exact: true }).click();
      await expect(notes).toHaveCount(0);
      await expect(stage).toHaveAttribute('data-state', 'manually-paused');
    }
  }
  await notes.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(stage).toHaveAttribute('data-state', 'playing');
  await expect(notes).toHaveCount(0);
  await page.keyboard.press('Escape');
});
