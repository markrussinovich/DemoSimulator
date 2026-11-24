import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from '../../src/main/store';
import type { Video } from '../../src/shared/model';

let app: ElectronApplication, page: Page, root: string, projectFile: string;
const referenceFrames: string[] = [];
test.describe.configure({ mode: 'serial' });
async function frameSignature(selector: string) {
  return page.locator(selector).evaluate(async (video: HTMLVideoElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const context = canvas.getContext('2d')!; context.drawImage(video, 0, 0);
    const digest = await crypto.subtle.digest('SHA-256', context.getImageData(0, 0, canvas.width, canvas.height).data);
    return Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('');
  });
}
async function seekPreview(time: number) {
  await page.locator('.preview').evaluate((video: HTMLVideoElement, target) => new Promise<void>(resolve => {
    video.addEventListener('seeked', () => resolve(), { once: true }); video.currentTime = target;
  }), time);
}
async function dialogPath(file: string, save = false) {
  await app.evaluate(({ dialog }, value) => {
    if (value.save) dialog.showSaveDialog = async () => ({ canceled: false, filePath: value.file });
    else dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [value.file] });
  }, { file, save });
}
async function saved() {
  await expect(page.locator('.save-status')).toContainText('Saved');
  await expect(page.locator('.notice[role="status"]')).toHaveCount(0, { timeout: 60000 });
}
async function editorGeometry() {
  return page.evaluate(() => ['.app-header', '.project-bar', '.editor-layout', '.preview-area', '.timeline-track', '.transport', '.cue-inspector', 'footer']
    .map(selector => ({ selector, ...document.querySelector(selector)!.getBoundingClientRect().toJSON() })));
}
test.beforeAll(async () => {
  root = await fs.mkdtemp(path.join(process.cwd(), 'test-e2e-'));
  projectFile = path.join(root, 'Sample presentation.demosim');
  const packaged = process.env.DEMOSIM_PACKAGED === '1', start = Date.now();
  app = await electron.launch({
    executablePath: packaged ? process.env.DEMOSIM_EXECUTABLE ?? path.join(process.cwd(), 'release', 'win-unpacked', 'Demo Simulator.exe') : undefined,
    args: [...(packaged ? [] : ['.']), `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd()
  });
  page = await app.firstWindow();
  page.on('pageerror', error => console.error('Renderer error:', error.message));
  page.on('dialog', async dialog => { if (dialog.type() !== 'beforeunload') await dialog.accept(); });
  await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeEnabled();
  console.log(`Interactive editor startup (${packaged ? 'packaged' : 'development'}): ${Date.now() - start} ms`);
});
test.afterAll(async () => {
  if (app) {
    await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; });
    await app.close();
  }
  if (root) await fs.rm(root, { recursive: true, force: true });
});
test('New/Add video/Save creates one project with an ordered set of both sample MP4s', async () => {
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.getByLabel('Fullscreen presentation')).toBeChecked();
  await page.getByLabel('Project name', { exact: true }).fill('Sample presentation');
  const files = (await fs.readdir(path.join(process.cwd(), 'samples'))).filter(name => name.endsWith('.mp4'));
  expect(files.length).toBeGreaterThanOrEqual(2);
  for (const [index, file] of files.entries()) {
    await dialogPath(path.join(process.cwd(), 'samples', file));
    await page.getByRole('button', { name: 'Add video', exact: true }).click();
    await expect(page.getByLabel('Video name', { exact: true })).toHaveValue(path.basename(file, '.mp4'));
    await expect(page.locator('.preview')).toHaveJSProperty('readyState', 4);
    await seekPreview(1);
    referenceFrames.push(await frameSignature('.preview'));
    await page.getByRole('button', { name: 'Add pause point', exact: true }).click();
    await expect(page.getByLabel('Pause time', { exact: true })).toHaveValue('1');
    await expect(page.getByRole('slider', { name: /^Pause point 1:/ })).toHaveAttribute('aria-valuenow', '1');
    await expect(page.locator('.video-list li')).toHaveCount(index + 1);
  }
  await expect(page.locator('.preview')).toHaveJSProperty('controls', false);
  await expect(page.locator('input[type="range"]')).toHaveCount(0);
  await expect(page.getByText('Named playlists', { exact: true })).toHaveCount(0);
  await dialogPath(projectFile, true);
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await saved();
  expect((await fs.stat(projectFile)).size).toBeGreaterThan(1000000);
  const document = await page.evaluate(() => window.demo.currentProject());
  expect(document!.catalog.version).toBe(2);
  expect(document!.catalog.projects).toHaveLength(1);
  expect(document!.catalog.projects[0].videos).toHaveLength(2);
});
test('blue markers and bold buttons remain legible, the empty inspector aligns, and media margins stay black in both themes', async () => {
  const originalTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const marker = page.getByRole('slider', { name: /^Pause point 1:/ });
  await marker.click();
  const cueId = await page.getByLabel('Selected pause point', { exact: true }).inputValue();
  await page.getByLabel('Fullscreen presentation').uncheck();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 560));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(900);
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
    await page.getByLabel('Selected pause point', { exact: true }).selectOption('');
    await page.mouse.move(0, 0);
    const presentation = await page.evaluate(() => {
      const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
      const rgb = (color: string) => color.match(/\d+/g)!.slice(0, 3).map(Number);
      const luminance = (color: string) => rgb(color).map(channel => {
        const value = channel / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
      }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      const contrast = (selector: string) => {
        const { color, backgroundColor } = style(selector), values = [luminance(color), luminance(backgroundColor)].sort((a, b) => b - a);
        return (values[0] + .05) / (values[1] + .05);
      };
      const hint = document.querySelector('.cue-hint')!.getBoundingClientRect(), picker = document.querySelector('.cue-picker select')!.getBoundingClientRect();
      const fullscreen = document.querySelector('.fullscreen-option input')!.getBoundingClientRect(), play = document.querySelector('.project-bar .primary')!.getBoundingClientRect();
      return {
        titleSize: parseFloat(style('.brand h1').fontSize),
        titleColor: rgb(style('.brand h1').color),
        shellBackground: rgb(style('body').backgroundColor),
        fullscreen: { width: fullscreen.width, height: fullscreen.height, rightOfPlay: fullscreen.left > play.right },
        markerColor: rgb(style('.pause-marker').backgroundColor),
        markerContrast: contrast('.pause-marker'), primaryContrast: contrast('.project-bar .primary'),
        buttonWeight: Number(style('.file-actions button').fontWeight),
        markerBackground: style('.pause-marker').backgroundColor,
        backgrounds: ['.preview-area', '.preview'].map(selector => style(selector).backgroundColor),
        objectFit: style('.preview').objectFit,
        alignment: Math.abs((hint.top + hint.bottom) / 2 - (picker.top + picker.bottom) / 2),
        overflow: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth
      };
    });
    expect(presentation.titleSize).toBeGreaterThan(20);
    expect(presentation.titleColor[2]).toBeGreaterThan(presentation.titleColor[0]);
    expect(presentation.titleColor[2]).toBeGreaterThan(presentation.titleColor[1]);
    expect(new Set(presentation.shellBackground).size).toBe(1);
    expect(presentation.fullscreen.width).toBeGreaterThanOrEqual(20);
    expect(presentation.fullscreen.height).toBeGreaterThanOrEqual(20);
    expect(presentation.fullscreen.rightOfPlay).toBe(true);
    expect(presentation.markerColor[2]).toBeGreaterThan(presentation.markerColor[0]);
    expect(presentation.markerColor[2]).toBeGreaterThan(presentation.markerColor[1]);
    expect(presentation.markerContrast).toBeGreaterThanOrEqual(4.5);
    expect(presentation.primaryContrast).toBeGreaterThanOrEqual(4.5);
    expect(presentation.buttonWeight).toBeGreaterThanOrEqual(600);
    expect(presentation.backgrounds).toEqual(['rgb(0, 0, 0)', 'rgb(0, 0, 0)']);
    expect(presentation.objectFit).toBe('contain');
    expect(presentation.alignment).toBeLessThan(1);
    expect(presentation.overflow).toBe(false);
    await page.screenshot({ path: path.join(process.cwd(), 'test-results', `editor-blue-${theme}.png`) });
    await page.getByLabel('Selected pause point', { exact: true }).selectOption(cueId);
    await expect(marker).toHaveClass(/selected/);
    expect(await marker.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(presentation.markerBackground);
    await page.getByRole('button', { name: 'Play this video', exact: true }).click();
    await expect(page.getByTestId('stage')).toHaveAttribute('data-state', 'ready');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('stage')).toHaveAttribute('data-state', 'cue-paused');
    expect(await page.evaluate(() => ['.stage', '.stage video'].map(selector => getComputedStyle(document.querySelector(selector)!).backgroundColor)))
      .toEqual(['rgb(0, 0, 0)', 'rgb(0, 0, 0)']);
    await page.screenshot({ path: path.join(process.cwd(), 'test-results', `player-black-${theme}.png`) });
    await page.keyboard.press('Escape');
  }
  await page.evaluate(theme => {
    if (theme) document.documentElement.setAttribute('data-theme', theme); else document.documentElement.removeAttribute('data-theme');
  }, originalTheme);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 760));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1280);
});
test('preview clicks and Play honor pauses, Reset rearms them, arrows step, and clicking away clears selection', async () => {
  const marker = page.getByRole('slider', { name: /^Pause point 1:/ });
  await marker.click();
  await expect(marker).toHaveClass(/selected/);
  await page.getByLabel('Pause name', { exact: true }).click();
  await expect(marker).toHaveClass(/selected/);
  await marker.focus();
  await page.locator('.brand h1').click();
  await expect(marker).not.toHaveClass(/selected/);
  await expect(marker).not.toBeFocused();
  await expect(page.getByLabel('Selected pause point', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect.poll(() => page.locator('.preview').evaluate((video: HTMLVideoElement) => video.currentTime)).toBe(0);
  await page.getByRole('button', { name: 'Next frame', exact: true }).click();
  await expect.poll(() => page.locator('.preview').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Previous frame', exact: true }).click();
  await expect.poll(() => page.locator('.preview').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(0, 3);
  expect(await page.getByTestId('timeline').evaluate(element => getComputedStyle(element).cursor)).toBe('text');
  expect(await page.locator('.timeline-rail').evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(4);
  await page.locator('.preview').click();
  await expect(page.getByRole('button', { name: 'Pause preview', exact: true })).toBeVisible();
  await expect.poll(() => page.locator('.preview').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(1, 3);
  await expect(page.locator('.preview')).toHaveJSProperty('paused', true);
  expect(await frameSignature('.preview')).toBe(referenceFrames[1]);
  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
  await expect.poll(() => page.locator('.preview').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(1.15);
  await page.getByRole('button', { name: 'Pause preview', exact: true }).click();
  await expect(page.locator('.preview')).toHaveJSProperty('paused', true);
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
  await expect.poll(() => page.locator('.preview').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(1, 3);
  await expect(page.locator('.preview')).toHaveJSProperty('paused', true);
  await marker.click();
  const track = (await page.getByTestId('timeline').boundingBox())!;
  await page.mouse.click(track.x + track.width / 2, track.y + 30);
  await expect(marker).not.toHaveClass(/selected/);
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
});
test('a pending save displays cancellable progress without moving any editor controls', async () => {
  await app.evaluate(({ dialog, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(900, 560);
    dialog.showSaveDialog = () => new Promise(resolve => {
      (globalThis as typeof globalThis & { finishSaveDialog?: () => void }).finishSaveDialog = () => resolve({ canceled: true, filePath: undefined });
    });
  });
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(900);
  const before = await editorGeometry(), digest = createHash('sha256').update(await fs.readFile(projectFile)).digest('hex');
  await page.getByRole('button', { name: 'Save as...', exact: true }).click();
  await expect(page.locator('.notice[role="status"]')).toBeVisible();
  expect(await editorGeometry()).toEqual(before);
  await page.screenshot({ path: path.join(process.cwd(), 'test-results', 'editor-blue-progress.png') });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await app.evaluate(() => {
    const pending = globalThis as typeof globalThis & { finishSaveDialog?: () => void };
    pending.finishSaveDialog!(); delete pending.finishSaveDialog;
  });
  await expect(page.locator('.notice[role="status"]')).toHaveCount(0);
  expect(await editorGeometry()).toEqual(before);
  expect(createHash('sha256').update(await fs.readFile(projectFile)).digest('hex')).toBe(digest);
  await dialogPath(projectFile, true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 760));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1280);
});
test('pause markers drag with the video, support cancel/keyboard edit, and delete off the track', async () => {
  const marker = page.getByRole('slider', { name: /^Pause point 1:/ });
  const track = (await page.getByTestId('timeline').boundingBox())!;
  const box = (await marker.boundingBox())!;
  const destination = track.x + track.width * .25;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(destination, box.y + box.height / 2, { steps: 8 });
  const draggedTime = Number(await marker.getAttribute('aria-valuenow'));
  expect(draggedTime).toBeGreaterThan(20);
  await expect.poll(() => page.locator('.preview').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(draggedTime, 2);
  await page.mouse.up();
  await marker.focus(); await page.keyboard.press('ArrowRight');
  const steppedTime = Number(await marker.getAttribute('aria-valuenow'));
  expect(steppedTime - draggedTime).toBeCloseTo(.033, 3);
  const before = (await marker.boundingBox())!;
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2); await page.mouse.down();
  await page.mouse.move(destination + 80, before.y + before.height / 2, { steps: 4 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(marker).toHaveAttribute('aria-valuenow', String(steppedTime));
  const updated = (await marker.boundingBox())!;
  await page.mouse.move(updated.x + updated.width / 2, updated.y + updated.height / 2); await page.mouse.down();
  await page.mouse.move(updated.x + updated.width / 2, track.y - 36, { steps: 4 }); await page.mouse.up();
  await expect(marker).toHaveCount(0);
  await seekPreview(1); await page.getByRole('button', { name: 'Add pause point', exact: true }).click();
  await marker.focus(); await page.keyboard.press('Delete'); await expect(marker).toHaveCount(0);
  await seekPreview(1.001); await page.getByRole('button', { name: 'Add pause point', exact: true }).click();
  await page.getByLabel('Pause time', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await saved();
});
test('videos reorder by drag and by buttons, and the order survives Open', async () => {
  const rows = page.locator('.video-list li');
  const names = await rows.locator('strong').allTextContents();
  await rows.first().dragTo(rows.last());
  await expect(rows.first().locator('strong')).toHaveText(names[1]);
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await saved();
  await dialogPath(projectFile);
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(rows.first().locator('strong')).toHaveText(names[1]);
  await rows.first().getByRole('button').click();
  await page.getByRole('button', { name: 'Move down', exact: true }).click();
  await expect(rows.first().locator('strong')).toHaveText(names[0]);
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await saved();
});
test('project playback preserves cues, native focus pauses, final frames and two-step next-video flow', async () => {
  await page.getByLabel('Fullscreen presentation').check();
  await page.getByRole('button', { name: 'Play project', exact: true }).click();
  const stage = page.getByTestId('stage');
  await expect(stage).toHaveAttribute('data-state', 'ready');
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
  await page.locator('.stage video').click(); await expect(stage).toHaveAttribute('data-state', 'cue-paused');
  expect(await frameSignature('.stage video')).toBe(referenceFrames[0]);
  await page.locator('.stage video').click(); await expect(stage).toHaveAttribute('data-state', 'playing');
  const ids = await app.evaluate(async ({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0];
    const other = new BrowserWindow({ width: 200, height: 150, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await other.loadURL('about:blank'); main.blur(); other.show(); other.focus(); return { main: main.id, other: other.id };
  });
  await expect(stage).toHaveAttribute('data-state', 'focus-paused');
  await app.evaluate(({ BrowserWindow }, ids) => { BrowserWindow.fromId(ids.other)?.close(); BrowserWindow.fromId(ids.main)?.focus(); }, ids);
  await expect(stage).toHaveAttribute('data-state', 'focus-paused');
  await page.keyboard.press('Space');
  await page.locator('.stage video').evaluate((video: HTMLVideoElement) => { video.currentTime = video.duration - .2; });
  await expect(stage).toHaveAttribute('data-state', 'item-ended');
  const finalFrame = await frameSignature('.stage video');
  await page.keyboard.press('Enter'); await expect(stage).toHaveAttribute('data-state', 'item-ended');
  expect(await frameSignature('.stage video')).toBe(finalFrame);
  await page.keyboard.press('Space');
  await expect(stage).toHaveAttribute('data-state', 'ready'); await expect(stage).toHaveAttribute('data-index', '1');
  expect(await page.locator('.stage video').evaluate((video: HTMLVideoElement) => video.paused && video.currentTime < .01)).toBe(true);
  await page.keyboard.press('Space'); await expect(stage).toHaveAttribute('data-state', 'cue-paused');
  expect(await frameSignature('.stage video')).toBe(referenceFrames[1]);
  await page.keyboard.press('Enter');
  await page.locator('.stage video').evaluate((video: HTMLVideoElement) => { video.currentTime = video.duration - .2; });
  await expect(stage).toHaveAttribute('data-state', 'playlist-ended');
  await page.keyboard.press('Space'); await expect(stage).toHaveAttribute('data-state', 'playlist-ended');
  await page.keyboard.press('Escape'); await expect(stage).toHaveCount(0);
});
test('Save cancellation preserves the document, Save As creates a copy and Ctrl+O reopens it', async () => {
  const previous = createHash('sha256').update(await fs.readFile(projectFile)).digest('hex');
  await page.getByLabel('Project name', { exact: true }).fill('Revised presentation');
  await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined }); });
  await page.getByRole('button', { name: 'Save as...', exact: true }).click();
  await expect(page.locator('.notice[role="status"]')).toHaveCount(0);
  await expect(page.locator('.save-status')).toContainText('Unsaved changes');
  expect(createHash('sha256').update(await fs.readFile(projectFile)).digest('hex')).toBe(previous);
  const copy = path.join(root, 'Revised presentation.demosim'); await dialogPath(copy, true);
  await page.keyboard.press('Control+Shift+S'); await saved();
  expect((await fs.stat(copy)).size).toBeGreaterThan(1000000);
  expect(createHash('sha256').update(await fs.readFile(projectFile)).digest('hex')).toBe(previous);
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.locator('.video-list li')).toHaveCount(0);
  await dialogPath(copy); await page.keyboard.press('Control+O');
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('Revised presentation');
  await expect(page.locator('.video-list li')).toHaveCount(2);
  await page.reload(); await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('Revised presentation');
});
test('layout keeps the timeline, video and controls visible at small window sizes with many videos/pauses', async () => {
  const store = await Store.open(path.join(root, 'many'));
  const sample = path.join(process.cwd(), 'samples', (await fs.readdir(path.join(process.cwd(), 'samples')))[0]);
  const media = await store.importMedia(sample, new AbortController().signal, () => {});
  const videos: Video[] = Array.from({ length: 28 }, (_, index) => ({
    id: randomUUID(), name: `Video ${index + 1}: a long title to test truncation without hiding buttons`, media: media.media,
    duration: 101.133333, width: 1920, height: 1080,
    cues: Array.from({ length: 24 }, (_, index) => ({ id: randomUUID(), name: `Pause ${index + 1}`, time: index + 1 }))
  }));
  const project = { id: randomUUID(), name: 'Project with many videos and pause points', videos: videos.map(video => video.id) };
  await store.save({ version: 2, projects: [project], videos });
  const file = path.join(root, 'many.demosim'); await store.exportBundle(project.id, file, new AbortController().signal, () => {});
  await dialogPath(file); await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(page.getByLabel('Video name', { exact: true })).toHaveValue(videos[0].name);
  await page.getByRole('slider', { name: /^Pause point 1:/ }).click();
  for (const [width, height] of [[900, 560], [1024, 650], [1280, 760]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    const geometry = await page.evaluate(() => {
      const selectors = ['.app-header', '.project-bar', '.videos-panel', '.preview-area', '.timeline-panel', '.transport', '.cue-inspector', 'footer'];
      return {
        overflow: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth,
        clipped: selectors.filter(selector => {
          const rect = document.querySelector(selector)!.getBoundingClientRect();
          return rect.bottom > innerHeight + 1 || rect.top < 0 || rect.right > innerWidth + 1 || rect.left < 0 || rect.height <= 0;
        })
      };
    });
    expect(geometry).toEqual({ overflow: false, clipped: [] });
    for (const name of ['Add pause point', 'Save as...', 'Play project', 'Delete pause']) await expect(page.getByRole('button', { name, exact: true })).toBeInViewport();
    await expect(page.locator('.video-list li')).toHaveCount(28);
    await expect(page.getByRole('button', { name: 'Previous videos', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Next videos', exact: true })).toHaveCount(0);
    await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(process.cwd(), 'test-results', `editor-${width}x${height}.png`) });
  }
  await page.locator('.video-list li').last().scrollIntoViewIfNeeded();
  await expect(page.locator('.video-list li').last()).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Remove video', exact: true })).toBeInViewport();
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  await page.screenshot({ path: path.join(process.cwd(), 'test-results', 'editor-ux.png') });
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close help', exact: true }).click();
  await dialogPath(projectFile); await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('Sample presentation');
});
test('non-frame-aligned markers remain editable and hold the decoded seek reference', async () => {
  await page.locator('.video-list li').first().getByRole('button').click();
  await expect(page.locator('.preview')).toHaveJSProperty('readyState', 4);
  const target = 2.417;
  await seekPreview(target); const reference = await frameSignature('.preview');
  await page.getByRole('button', { name: 'Add pause point', exact: true }).click();
  await expect(page.getByLabel('Pause time', { exact: true })).toHaveValue('2.417');
  await page.getByLabel('Fullscreen presentation').uncheck();
  await page.getByRole('button', { name: 'Play this video', exact: true }).click();
  const stage = page.getByTestId('stage'); await expect(stage).toHaveAttribute('data-state', 'ready');
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false);
  await page.keyboard.press('Space'); await expect(stage).toHaveAttribute('data-state', 'cue-paused');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.locator('.stage video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(target, 3);
  await expect(stage).toHaveAttribute('data-state', 'cue-paused');
  expect(await frameSignature('.stage video')).toBe(reference);
  await page.keyboard.press('Escape');
});
test('editor name entry does not control playback and close retains unsaved edits when cancelled', async () => {
  await page.getByLabel('Project name', { exact: true }).fill('Unsaved demo');
  await page.getByLabel('Project name', { exact: true }).press('Space');
  await expect(page.getByTestId('stage')).toHaveCount(0);
  await app.evaluate(({ dialog, BrowserWindow }) => { dialog.showMessageBoxSync = () => 0; BrowserWindow.getAllWindows()[0].close(); });
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('Unsaved demo ');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await saved();
});
test('legacy workspace migration preserves originals and converts each sequence into a multi-video project', async () => {
  const legacy = await Store.open(path.join(root, 'legacy'));
  const sample = path.join(process.cwd(), 'samples', (await fs.readdir(path.join(process.cwd(), 'samples')))[0]);
  const media = await legacy.importMedia(sample, new AbortController().signal, () => {});
  const video: Video = { id: randomUUID(), name: 'Legacy one', media: media.media, duration: 101.133333, width: 1920, height: 1080, cues: [{ id: randomUUID(), name: 'Legacy cue', time: 1 }] };
  const second = { ...video, id: randomUUID(), name: 'Legacy two' };
  const third = { ...video, id: randomUUID(), name: 'Standalone demo' };
  const list = { id: randomUUID(), name: 'Legacy sequence', projects: [video.id, second.id, video.id] };
  const original = JSON.stringify({ version: 1, projects: [video, second, third], playlists: [list] });
  await fs.writeFile(path.join(legacy.path, 'catalog.json'), original);
  await dialogPath(legacy.path);
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await page.getByRole('button', { name: 'Open a previous-version workspace...', exact: true }).click();
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('Legacy sequence');
  await expect(page.locator('.video-list li')).toHaveCount(3);
  await page.locator('.video-list li').last().getByRole('button').click();
  await expect(page.locator('.video-list button[aria-current="true"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove video', exact: true }).click();
  await expect(page.locator('.video-list li')).toHaveCount(2);
  expect(await page.locator('.video-list strong').allTextContents()).toEqual(['Legacy one', 'Legacy two']);
  await dialogPath(path.join(root, 'Migrated.demosim'), true);
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await saved();
  expect(await fs.readFile(path.join(legacy.path, 'catalog.json'), 'utf8')).toBe(original);
  await page.getByLabel('Recovered project', { exact: true }).selectOption(third.id);
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('Standalone demo');
  await expect(page.locator('.video-list li')).toHaveCount(1);
  await dialogPath(projectFile); await page.getByRole('button', { name: 'Open project', exact: true }).click();
});
test('WebM with recorded audio plays silently in the editor and windowed player', async () => {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d')!, stream = canvas.captureStream(30);
    const audio = new AudioContext(), oscillator = audio.createOscillator(), destination = audio.createMediaStreamDestination();
    oscillator.connect(destination); oscillator.start();
    destination.stream.getAudioTracks().forEach(track => stream.addTrack(track));
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' }), chunks: Blob[] = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const finished = new Promise<Blob>(resolve => { recorder.onstop = () => resolve(new Blob(chunks)); });
    let frame = 0;
    const draw = () => {
      context.fillStyle = frame % 2 ? 'white' : 'black'; context.fillRect(0, 0, 320, 180);
      context.fillStyle = 'red'; context.font = '32px monospace'; context.fillText(`Frame ${frame++}`, 30, 100);
    };
    draw(); recorder.start(); const timer = setInterval(draw, 1000 / 30);
    await new Promise(resolve => setTimeout(resolve, 2200));
    clearInterval(timer); recorder.stop();
    const blob = await finished; stream.getTracks().forEach(track => track.stop()); await audio.close();
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  const file = path.join(root, 'Numbered WebM.webm'); await fs.writeFile(file, Buffer.from(bytes));
  await dialogPath(file); await page.getByRole('button', { name: 'Add video', exact: true }).click();
  await expect(page.getByLabel('Video name', { exact: true })).toHaveValue('Numbered WebM');
  await expect(page.locator('.preview')).toHaveJSProperty('muted', true);
  await page.getByRole('button', { name: 'Play preview', exact: true }).click();
  await expect(page.locator('.preview')).toHaveJSProperty('paused', false);
  await expect(page.locator('.preview')).toHaveJSProperty('muted', true);
  await page.getByRole('button', { name: 'Pause preview', exact: true }).click();
  await seekPreview(1); const reference = await frameSignature('.preview');
  await page.getByRole('button', { name: 'Add pause point', exact: true }).click();
  await page.getByLabel('Fullscreen presentation').uncheck();
  await page.getByRole('button', { name: 'Play this video', exact: true }).click();
  await expect(page.getByTestId('stage')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('.stage video')).toHaveJSProperty('muted', true);
  await page.keyboard.press('Space'); await expect(page.getByTestId('stage')).toHaveAttribute('data-state', 'cue-paused');
  await expect(page.locator('.stage video')).toHaveJSProperty('muted', true);
  expect(await frameSignature('.stage video')).toBe(reference);
  await page.keyboard.press('Enter'); await expect(page.getByTestId('stage')).toHaveAttribute('data-state', 'playlist-ended');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await saved();
});
test('a failed Open leaves the current project usable', async () => {
  const name = await page.getByLabel('Project name', { exact: true }).inputValue();
  const before = await editorGeometry();
  const file = path.join(root, 'broken.demosim'); await fs.writeFile(file, 'not a project archive');
  await dialogPath(file); await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await editorGeometry()).toEqual(before);
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue(name);
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  expect(await editorGeometry()).toEqual(before);
  await expect(page.getByRole('button', { name: 'Play project', exact: true })).toBeEnabled();
});
test('the last multi-video project restores quickly on relaunch, including its preview', async () => {
  const name = await page.getByLabel('Project name', { exact: true }).inputValue();
  await app.close();
  const packaged = process.env.DEMOSIM_PACKAGED === '1', start = Date.now();
  app = await electron.launch({
    executablePath: packaged ? process.env.DEMOSIM_EXECUTABLE ?? path.join(process.cwd(), 'release', 'win-unpacked', 'Demo Simulator.exe') : undefined,
    args: [...(packaged ? [] : ['.']), `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd()
  });
  page = await app.firstWindow();
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue(name);
  await expect(page.locator('.video-list li')).toHaveCount(3);
  await expect(page.locator('.preview')).toHaveJSProperty('readyState', 4);
  console.log(`Restored multi-video project and decoded preview (${packaged ? 'packaged' : 'development'}): ${Date.now() - start} ms`);
});
