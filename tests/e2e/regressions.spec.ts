import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from '../../src/main/store';
import type { Video } from '../../src/shared/model';

let app: ElectronApplication, page: Page, root: string;
test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(process.cwd(), 'test-e2e-regression-'));
  const packaged = process.env.DEMOSIM_PACKAGED === '1';
  app = await electron.launch({
    executablePath: packaged ? process.env.DEMOSIM_EXECUTABLE ?? path.join(process.cwd(), 'release', 'win-unpacked', 'Demo Simulator.exe') : undefined,
    args: [...(packaged ? [] : ['.']), `--user-data-dir=${path.join(root, 'profile')}`], cwd: process.cwd()
  });
  page = await app.firstWindow();
  page.on('dialog', async dialog => { if (dialog.type() !== 'beforeunload') await dialog.accept(); });
  await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeEnabled();
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
