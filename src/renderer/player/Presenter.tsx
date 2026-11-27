import { useCallback, useEffect, useRef, useState } from 'react';
import { mediaUrl, type PresentationCommand, type PresentationSession, type PresentationState } from '../../shared/model';
import { formatTime } from '../editor/Timeline';

export function Presenter({ session, onError }: { session: PresentationSession; onError: (message: string) => void }) {
  const [state, setState] = useState<PresentationState>({ id: session.id, index: 0, state: 'loading', position: 0, error: '' });
  const [stopping, setStopping] = useState(false);
  const preview = useRef<HTMLVideoElement>(null);
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => {
    let active = true, received = false;
    const unsubscribe = window.demo.onPresentationState(value => {
      if (value.id === session.id) { received = true; setState(value); }
    });
    void window.demo.presentationState(session.id).then(value => { if (active && value && !received) setState(value); }).catch(error => onError(String(error)));
    return () => { active = false; unsubscribe(); };
  }, [session.id, onError]);
  const command = useCallback((command: PresentationCommand) => {
    void window.demo.presentationCommand(session.id, command).catch(error => onError(String(error)));
  }, [session.id, onError]);
  const stop = useCallback(() => {
    setStopping(true);
    void window.demo.stopPresentation(session.id).catch(error => { setStopping(false); onError(String(error)); });
  }, [session.id, onError]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.altKey || event.metaKey ||
        document.querySelector('dialog[open]')) return;
      if (event.code === 'Escape') { event.preventDefault(); stop(); return; }
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, button, [contenteditable="true"]')) return;
      if (event.code === 'Space' || event.code === 'Enter') {
        event.preventDefault(); command({ kind: 'input', input: event.code === 'Space' ? 'space' : 'enter' });
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [command, stop]);
  const video = session.videos[state.index];
  const cue = video.cues.filter(cue => cue.time <= state.position).at(-1);
  useEffect(() => {
    const element = preview.current;
    return () => { element?.pause(); element?.removeAttribute('src'); element?.load(); };
  }, [state.index, video.media]);
  const synchronize = useCallback(() => {
    const element = preview.current;
    if (!element || element.readyState < 2) return;
    const position = Math.max(0, Math.min(state.position, video.duration - .001));
    if (state.state === 'playing') {
      if (element.ended || Math.abs(element.currentTime - position) > .25) element.currentTime = position;
      if (element.paused) void element.play().then(() => {
        if (latest.current.state !== 'playing' || preview.current !== element) element.pause();
      }).catch(() => {});
    } else {
      element.pause();
      if (Math.abs(element.currentTime - position) > .001) element.currentTime = position;
    }
  }, [state.state, state.position, video.duration]);
  useEffect(synchronize, [synchronize]);
  const unavailable = ['loading', 'seeking', 'error'].includes(state.state);
  const labels = {
    loading: 'Loading video', seeking: 'Seeking', ready: 'Ready to start', playing: 'Playing',
    'manually-paused': 'Paused', 'focus-paused': 'Paused - switched away',
    'cue-paused': `Paused at ${cue?.name ?? 'pause point'}`, 'item-ended': 'Video ended - next video available',
    'playlist-ended': 'Final video ended', error: 'Playback stopped'
  };
  return <section className="presenter-session" aria-label="Audience presentation">
    <video key={`${state.index}-${video.media}`} ref={preview} className="audience-preview" src={mediaUrl(video.media, session.id)}
      aria-label="Live audience preview" muted crossOrigin="anonymous" disablePictureInPicture onLoadedData={synchronize} />
    <div className="presenter-transport">
      <strong className="presentation-video" title={video.name}>Video {state.index + 1}/{session.videos.length}: {video.name}</strong>
      <strong role="status" aria-label="Presentation status" className="presentation-status" data-state={state.state}>{labels[state.state]}</strong>
      <input aria-label="Audience playback position" type="range" min="0" max={video.duration} step=".001" value={state.position}
        disabled={unavailable} onChange={event => command({ kind: 'seek', time: Number(event.target.value) })} />
      <div className="row">
        <button disabled={unavailable} onClick={() => command({ kind: 'seek', time: 0 })}>Start of presentation video</button>
        <button disabled={unavailable} onClick={() => command({ kind: 'previous-cue' })}>Previous presentation pause</button>
        <button className="primary" disabled={unavailable || state.state === 'playlist-ended'}
          onClick={() => command({ kind: 'input', input: 'space' })}>
          {state.state === 'playing' ? 'Pause presentation' : state.state === 'item-ended' ? 'Next presentation video' : 'Resume presentation'}
        </button>
        <output>{formatTime(state.position)} / {formatTime(video.duration)}</output>
        <button disabled={stopping} onClick={stop}>Stop presenting</button>
      </div>
      <p className="notes-hint">Edits apply next time. Space controls the audience outside editor controls; Esc stops.</p>
      {state.error && <p className="error" role="alert">{state.error}</p>}
    </div>
    <aside className="presentation-notes" aria-label="Live presentation notes">
      <strong>{cue ? cue.name : 'Video default'}</strong>
      <div>{cue?.notes ?? video.notes ?? 'No notes for this section.'}</div>
      <select aria-label="Audience pause point" value={cue?.id ?? ''} disabled={unavailable}
        onChange={event => command({ kind: 'seek', time: video.cues.find(cue => cue.id === event.target.value)?.time ?? 0 })}>
        <option value="">Start of video</option>{video.cues.map(cue => <option key={cue.id} value={cue.id}>{cue.name}</option>)}
      </select>
    </aside>
  </section>;
}
