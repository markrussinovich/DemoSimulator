import { describe, expect, it, vi } from 'vitest';
import { PlaybackController, inputAction } from '../src/renderer/player/controller';
import type { Video } from '../src/shared/model';

class FakeVideo extends EventTarget {
  currentTime = 0; duration = 5; seeking = false;
  pause = vi.fn();
  play = vi.fn(() => Promise.resolve());
  requestVideoFrameCallback = vi.fn(() => 1);
  cancelVideoFrameCallback = vi.fn();
}
const projects = [
  { duration: 5, cues: [{ time: 1, id: 'cue', name: 'Pause' }] },
  { duration: 5, cues: [] }
] as Video[];
function setup() {
  const video = new FakeVideo();
  const load = vi.fn();
  const c = new PlaybackController(video as unknown as HTMLVideoElement, projects, () => {}, load, () => true);
  c.start(); video.dispatchEvent(new Event('loadeddata'));
  return { video, c, load };
}
describe('presenter transitions', () => {
  it('requires Space then another input to load and start the next item; final never loops', async () => {
    const { c, video, load } = setup();
    expect(c.state).toBe('ready');
    await c.input('space'); expect(c.state).toBe('playing');
    video.dispatchEvent(new Event('ended')); expect(c.state).toBe('item-ended');
    await c.input('enter'); await c.input('click'); expect(load).toHaveBeenCalledTimes(1);
    await c.input('space'); expect(c.state).toBe('loading'); expect(c.index).toBe(1);
    video.dispatchEvent(new Event('loadeddata')); expect(c.state).toBe('ready');
    await c.input('space'); video.dispatchEvent(new Event('ended'));
    expect(c.state).toBe('playlist-ended');
    await c.input('space'); expect(c.index).toBe(1);
    c.dispose();
  });
  it('consumes a crossed cue and does not fire it again after resuming', async () => {
    const { c, video } = setup();
    await c.input('space');
    video.currentTime = 1.4; video.dispatchEvent(new Event('timeupdate'));
    expect(c.state).toBe('seeking'); expect(video.currentTime).toBe(1);
    video.dispatchEvent(new Event('seeked')); expect(c.state).toBe('cue-paused');
    await c.input('click'); video.currentTime = 1.1; video.dispatchEvent(new Event('timeupdate'));
    expect(c.state).toBe('playing'); c.dispose();
  });
  it('pauses on focus loss even if play resolves later and requires explicit resume', async () => {
    const { c, video } = setup();
    let resolve!: () => void;
    video.play.mockImplementation(() => new Promise<void>(r => { resolve = r; }));
    const playing = c.input('space'); c.blur(); resolve(); await playing;
    expect(c.state).toBe('focus-paused'); expect(video.pause).toHaveBeenCalled();
    c.refocus(); expect(c.state).toBe('focus-paused'); c.dispose();
  });
  it('stops input during loading/seeking and only Space pauses active playback', () => {
    expect(inputAction('loading', 'space')).toBe('none');
    expect(inputAction('seeking', 'space')).toBe('none');
    expect(inputAction('playing', 'click')).toBe('none');
    expect(inputAction('playing', 'enter')).toBe('none');
    expect(inputAction('playing', 'space')).toBe('pause');
  });
  it('ignores old play completion without pausing a newer playback request', async () => {
    const { c, video } = setup();
    let oldResolve!: () => void;
    video.play.mockImplementationOnce(() => new Promise<void>(resolve => { oldResolve = resolve; }));
    const old = c.input('space');
    await c.input('space');
    await c.input('space');
    const pauses = video.pause.mock.calls.length;
    oldResolve(); await old;
    expect(c.state).toBe('playing');
    expect(video.pause.mock.calls.length).toBe(pauses);
    c.dispose();
  });
  it('reports rejected play requests instead of leaving an apparently playing video', async () => {
    const { c, video } = setup();
    video.play.mockRejectedValueOnce(new Error('decode failure'));
    await c.input('enter');
    expect(c.state).toBe('error');
    expect(c.error).toContain('decode failure');
    c.dispose();
  });
});
