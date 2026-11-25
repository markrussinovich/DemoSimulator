import type { Video } from '../../shared/model';
export type State = 'loading' | 'seeking' | 'ready' | 'playing' | 'manually-paused' | 'cue-paused' | 'focus-paused' | 'item-ended' | 'playlist-ended' | 'error';
export type Input = 'space' | 'enter' | 'click';
export function inputAction(state: State, input: Input): 'play' | 'pause' | 'next' | 'none' {
  if (state === 'playing') return input === 'space' ? 'pause' : 'none';
  if (state === 'item-ended') return input === 'space' ? 'next' : 'none';
  if (['ready', 'manually-paused', 'cue-paused', 'focus-paused'].includes(state)) return 'play';
  return 'none';
}
export class PlaybackController {
  state: State = 'loading';
  index = 0;
  error = '';
  buffering = false;
  heldTime = 0;
  decodedTime = 0;
  lastOvershoot = 0;
  private cue = 0;
  private generation = 0;
  private frameCallback?: number;
  private timeout?: ReturnType<typeof setTimeout>;
  private fallback?: ReturnType<typeof setInterval>;
  private disposed = false;
  private seekingTo: State = 'ready';
  private focused = true;
  private discovering = false;
  private resumeAfterSeek = false;
  private removers: (() => void)[] = [];
  constructor(
    readonly video: HTMLVideoElement,
    readonly projects: Video[],
    private notify: () => void,
    private load: (project: Video) => void,
    private focus: () => boolean = () => document.hasFocus()
  ) {
    const listen = (name: keyof HTMLMediaElementEventMap, handler: () => void) => {
      video.addEventListener(name, handler); this.removers.push(() => video.removeEventListener(name, handler));
    };
    const loaded = () => {
      if (this.state !== 'loading') return;
      if (video.readyState !== undefined && video.readyState < 2) return;
      if (video.duration === Infinity && !this.discovering) {
        this.discovering = true; video.currentTime = 1e10; return;
      }
      if (this.discovering && !Number.isFinite(video.duration)) return;
      if (!Number.isFinite(video.duration) || video.duration <= 0) { this.fail('Video duration is unavailable. Re-encode as MP4 (H.264/AAC) or seekable WebM.'); return; }
      if (Math.abs(video.duration - this.projects[this.index].duration) > .5) { this.fail('Media changed since this project was saved. Reimport the recording.'); return; }
      this.hold(0, 'ready');
    };
    listen('loadeddata', loaded); listen('durationchange', loaded);
    listen('seeked', () => {
      if (this.state === 'loading' && this.discovering) { loaded(); return; }
      if (this.state !== 'seeking') return;
      this.settleHold();
    });
    listen('ended', () => {
      if (this.state !== 'playing') return;
      this.stopClock(); this.clearTimeout();
      this.state = this.index + 1 < projects.length ? 'item-ended' : 'playlist-ended';
      this.notify();
    });
    listen('error', () => this.fail('Video could not be decoded. Check the media file and use MP4 (H.264/AAC) or WebM.'));
    listen('waiting', () => {
      this.buffering = true;
      if (this.state === 'playing') this.armTimeout('Playback stalled. Check the media file and restart.');
      this.notify();
    });
    listen('playing', () => {
      this.buffering = false;
      if (this.state !== 'playing') video.pause();
      else if (!this.focused || !this.focus()) this.pause('focus-paused');
      else this.clearTimeout();
      this.notify();
    });
    listen('timeupdate', () => { if (this.state === 'playing') this.checkCue(video.currentTime); });
  }
  start() {
    if (!this.projects.length) { this.fail('This playlist is empty.'); return; }
    this.loadItem();
  }
  private loadItem() {
    this.generation++; this.video.pause(); this.stopClock();
    this.state = 'loading'; this.cue = 0; this.error = ''; this.buffering = false; this.discovering = false;
    this.armTimeout('Video loading stalled. Check that the media is available.');
    this.load(this.projects[this.index]); this.notify();
  }
  async input(input: Input) {
    if (this.disposed) return;
    const action = inputAction(this.state, input);
    if (action === 'next') { this.index++; this.loadItem(); return; }
    if (action === 'pause') { this.pause('manually-paused'); return; }
    if (action !== 'play' || !this.focused || !this.focus()) return;
    const token = ++this.generation;
    this.state = 'playing'; this.notify(); this.clock();
    this.armTimeout('Playback did not start. Check the recording or restart the demo.');
    try {
      await this.video.play();
      if (token !== this.generation || this.disposed) return;
      if (!this.focused || !this.focus()) {
        this.pause('focus-paused'); return;
      }
      this.clearTimeout();
    } catch (error) {
      if (token === this.generation && !this.disposed) this.fail(`Playback failed: ${String(error)}`);
    }
  }
  blur() {
    this.focused = false;
    this.resumeAfterSeek = false;
    if (this.state === 'playing') this.pause('focus-paused');
  }
  refocus() { this.focused = true; }
  pause(state: State) {
    this.resumeAfterSeek = false;
    this.generation++; this.video.pause(); this.stopClock(); this.clearTimeout();
    this.state = state; this.notify();
  }
  seek(time: number) {
    const project = this.projects[this.index];
    if (this.disposed || !project || !Number.isFinite(time) || this.state === 'loading' || this.state === 'error') return;
    const target = Math.max(0, Math.min(project.duration - .001, time));
    this.cue = project.cues.filter(point => point.time <= target).length;
    this.buffering = false;
    this.hold(target, 'manually-paused');
  }
  previousCue() {
    const project = this.projects[this.index];
    if (!project) return;
    const point = [...project.cues].sort((a, b) => a.time - b.time).filter(point => point.time < this.video.currentTime - .001).at(-1);
    this.seek(point?.time ?? 0);
  }
  resume() {
    if (this.disposed) return;
    if (this.state === 'seeking') this.resumeAfterSeek = true;
    else void this.input('space');
  }
  private hold(time: number, after: State) {
    this.resumeAfterSeek = false;
    this.generation++; this.video.pause(); this.stopClock();
    this.state = 'seeking'; this.seekingTo = after; this.heldTime = time;
    this.armTimeout('Could not seek to the pause point. Try re-encoding the recording.');
    this.notify();
    if (Math.abs(this.video.currentTime - time) < .001 && !this.video.seeking) this.settleHold();
    else this.video.currentTime = time;
  }
  private settleHold() {
    this.clearTimeout();
    this.state = this.seekingTo;
    this.notify();
    if (this.resumeAfterSeek) { this.resumeAfterSeek = false; void this.input('space'); }
  }
  private checkCue(time: number) {
    if (this.state !== 'playing') return;
    const cues = [...this.projects[this.index].cues].sort((a, b) => a.time - b.time);
    const point = cues[this.cue];
    if (point && time >= point.time) {
      this.lastOvershoot = Math.max(0, time - point.time);
      this.cue++;
      // Cue consumption precedes seeking, so resume cannot refire the same point.
      this.hold(point.time, 'cue-paused');
    }
  }
  private clock() {
    this.stopClock();
    if ('requestVideoFrameCallback' in this.video) {
      const frame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        if (this.state !== 'playing' || this.disposed) return;
        this.decodedTime = metadata.mediaTime;
        this.checkCue(metadata.mediaTime);
        if (this.state === 'playing') this.frameCallback = this.video.requestVideoFrameCallback(frame);
      };
      this.frameCallback = this.video.requestVideoFrameCallback(frame);
    } else this.fallback = setInterval(() => this.checkCue(this.video.currentTime), 16);
  }
  private stopClock() {
    if (this.frameCallback !== undefined) this.video.cancelVideoFrameCallback(this.frameCallback);
    this.frameCallback = undefined;
    if (this.fallback) clearInterval(this.fallback);
    this.fallback = undefined;
  }
  private armTimeout(message: string) { this.clearTimeout(); this.timeout = setTimeout(() => this.fail(message), 30000); }
  private clearTimeout() { if (this.timeout) clearTimeout(this.timeout); this.timeout = undefined; }
  private fail(message: string) { if (this.disposed) return; this.error = message; this.pause('error'); }
  dispose() {
    this.disposed = true; this.generation++; this.video.pause(); this.stopClock(); this.clearTimeout();
    this.removers.forEach(remove => remove());
  }
}
