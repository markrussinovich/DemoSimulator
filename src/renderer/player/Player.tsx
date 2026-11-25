import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { mediaUrl, type Video } from '../../shared/model';
import { PlaybackController } from './controller';
import { formatTime } from '../editor/Timeline';

type PanelKind = 'timeline' | 'notes';
type Panel = { kind: PanelKind; hover: boolean };

export function Player({ projects, exit }: { projects: Video[]; exit: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const controller = useRef<PlaybackController | null>(null);
  const [, render] = useState(0);
  const [cover, setCover] = useState('');
  const [restart, setRestart] = useState(0);
  const [panel, setPanel] = useState<Panel | null>(null);
  const visiblePanel = useRef<Panel | null>(null);
  const hover = useRef<{ kind: PanelKind; timer: ReturnType<typeof setTimeout> } | null>(null);
  const controlsPanel = useRef<HTMLElement>(null);
  const notesPanel = useRef<HTMLElement>(null);
  const positionSlider = useRef<HTMLInputElement>(null);
  const [notesWidth] = useState(() => {
    try {
      const width = Number(localStorage.getItem('presenter-notes-width'));
      return Number.isFinite(width) && width >= 220 ? width : 260;
    } catch { return 260; }
  });
  const clearHover = useCallback(() => {
    if (hover.current) clearTimeout(hover.current.timer);
    hover.current = null;
  }, []);
  const showPanel = useCallback((kind: PanelKind | null, hover = false) => {
    clearHover();
    visiblePanel.current = kind ? { kind, hover } : null; setPanel(visiblePanel.current);
    if (kind) {
      if (controller.current && ['playing', 'seeking'].includes(controller.current.state)) controller.current.pause('manually-paused');
      if (kind === 'timeline' && !hover) requestAnimationFrame(() => {
        if (visiblePanel.current?.kind === 'timeline') positionSlider.current?.focus();
      });
    }
  }, [clearHover]);
  const resume = () => { showPanel(null); controller.current?.resume(); };
  const leaveStage = () => {
    clearHover();
    if (visiblePanel.current?.hover) showPanel(null);
  };
  const movePointer = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse') return;
    if (event.buttons) { clearHover(); return; }
    const bounds = event.currentTarget.getBoundingClientRect();
    const active = visiblePanel.current;
    const inside = active?.kind === 'timeline'
      ? event.clientY >= bounds.bottom - (controlsPanel.current?.offsetHeight ?? 0)
      : active?.kind === 'notes' && event.clientX >= bounds.right - (notesPanel.current?.offsetWidth ?? 0);
    if (active && inside) { clearHover(); return; }
    if (active?.hover) showPanel(null);
    const kind = event.clientY >= bounds.bottom - 12 ? 'timeline' : event.clientX >= bounds.right - 12 ? 'notes' : null;
    if (!kind || visiblePanel.current?.kind === kind) { clearHover(); return; }
    if (hover.current?.kind === kind) return;
    clearHover();
    hover.current = { kind, timer: setTimeout(() => {
      hover.current = null;
      if (document.hasFocus() && controller.current && !['loading', 'error'].includes(controller.current.state)) showPanel(kind, true);
    }, 1000) };
  };
  useEffect(() => {
    const element = video.current!;
    const c = new PlaybackController(element, projects, () => {
      if (!['loading', 'seeking'].includes(c.state)) setCover('');
      render(value => value + 1);
    }, project => {
      if (element.readyState >= 2) {
        const canvas = document.createElement('canvas');
        canvas.width = element.videoWidth; canvas.height = element.videoHeight;
        canvas.getContext('2d')!.drawImage(element, 0, 0);
        setCover(canvas.toDataURL());
      }
      element.src = mediaUrl(project.media); element.load();
    });
    controller.current = c;
    const key = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.code === 'Escape') { event.preventDefault(); exit(); return; }
      if (event.code === 'Space' && event.ctrlKey) {
        event.preventDefault(); showPanel(visiblePanel.current?.kind === 'timeline' ? null : 'timeline'); return;
      }
      if (event.code === 'Space' && visiblePanel.current && !(event.target instanceof HTMLElement && event.target.closest('.error-panel'))) {
        event.preventDefault(); showPanel(null); c.resume(); return;
      }
      if (event.target instanceof HTMLElement && event.target.closest('button')) return;
      if (event.code === 'Space' || event.code === 'Enter') {
        event.preventDefault(); clearHover();
        if (visiblePanel.current) { showPanel(null); c.resume(); }
        else void c.input(event.code === 'Space' ? 'space' : 'enter');
      }
    };
    const blur = () => {
      clearHover();
      if (visiblePanel.current?.hover) showPanel(null);
      c.blur();
    };
    const focus = () => c.refocus();
    window.addEventListener('keydown', key); window.addEventListener('blur', blur); window.addEventListener('focus', focus);
    const unsubscribe = window.demo.onFullscreen(enabled => { if (!enabled) exit(); });
    const unsubscribeFocus = window.demo.onFocus(focused => { if (focused) c.refocus(); else blur(); });
    c.start();
    return () => {
      clearHover(); c.dispose(); controller.current = null; unsubscribe(); unsubscribeFocus();
      window.removeEventListener('keydown', key); window.removeEventListener('blur', blur); window.removeEventListener('focus', focus);
    };
  }, [projects, exit, restart, showPanel, clearHover]);
  const current = controller.current;
  const project = projects[current?.index ?? 0];
  const position = current?.video.currentTime ?? 0;
  const progress = project.duration > 0 ? position / project.duration * 100 : 0;
  const notesCue = project.cues.filter(cue => cue.time <= position).at(-1);
  const notes = notesCue?.notes ?? project.notes ?? '';
  const controlsOpen = panel?.kind === 'timeline';
  const notesOpen = panel?.kind === 'notes';
  const unavailable = !current || ['loading', 'error'].includes(current.state);
  const playLabel = current?.state === 'item-ended' ? 'Next video' : 'Play';
  return <div className="stage" data-testid="stage" data-state={current?.state ?? 'loading'} data-index={current?.index ?? 0} data-overshoot={current?.lastOvershoot ?? 0}
    data-controls-open={controlsOpen} data-notes-open={notesOpen} onPointerMove={movePointer} onPointerUp={movePointer} onPointerDown={clearHover} onPointerLeave={leaveStage}>
    <video ref={video} crossOrigin="anonymous" onClick={event => {
      if (event.button === 0) { showPanel(null); void controller.current?.input('click'); }
    }} muted disablePictureInPicture />
    {cover && <img className="cover" src={cover} alt="" />}
    <section ref={controlsPanel} className={`playback-controls${controlsOpen ? ' open' : ''}`} aria-label="Playback controls" aria-hidden={!controlsOpen} inert={!controlsOpen}>
      <div className="playback-seekbar">
        <div className="timeline-rail" /><div className="timeline-fill" style={{ width: `${progress}%` }} />
        <input ref={positionSlider} aria-label="Playback position" type="range" min={0} max={project.duration} step=".001" value={position}
          aria-valuetext={formatTime(position)} disabled={unavailable} onChange={event => current?.seek(Number(event.target.value))} />
        {project.cues.map((cue, index) => <button key={cue.id} className="playback-cue" disabled={unavailable}
          aria-label={`Seek to pause ${index + 1}: ${cue.name}`} title={`${cue.name} - ${formatTime(cue.time)}`}
          style={{ left: `${cue.time / project.duration * 100}%` }} onClick={() => current?.seek(cue.time)}>{index + 1}</button>)}
      </div>
      <div className="playback-actions">
        <button disabled={unavailable} aria-label="Start of video" title="Start of video" onClick={() => current?.seek(0)}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M1 1h3v14H1zm14 0L5 8l10 7z" /></svg>
        </button>
        <button disabled={unavailable} aria-label="Previous pause" title="Previous pause" onClick={() => current?.previousCue()}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="m10 3-5 5 5 5" /></svg>
        </button>
        <button className="primary" disabled={unavailable || current?.state === 'playlist-ended'} aria-label={playLabel} title={playLabel} onClick={resume}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor"
            d={current?.state === 'item-ended' ? 'M12 1h3v14h-3zM1 1l10 7-10 7z' : 'm2 1 12 7-12 7z'} /></svg>
        </button>
        <output aria-label="Playback time">{formatTime(position)} / {formatTime(project.duration)}</output>
        <small>Ctrl+Space: toggle / Space: play</small>
      </div>
    </section>
    <aside ref={notesPanel} className={`playback-notes${notesOpen ? ' open' : ''}`} style={{ width: notesWidth }}
      aria-label="Presenter notes" aria-hidden={!notesOpen} inert={!notesOpen}>
      <div className="panel-heading"><h2>Presenter notes</h2><button aria-label="Close presenter notes" onClick={() => showPanel(null)}>Close</button></div>
      <p className="notes-context">{notesCue ? `${project.cues.indexOf(notesCue) + 1}. ${notesCue.name}` : 'Video default'}</p>
      <div className={`playback-notes-content${notes ? '' : ' muted'}`}>{notes || 'No notes for this section.'}</div>
      <div className="playback-notes-actions">
        <button className="primary" disabled={unavailable || current?.state === 'playlist-ended'} onClick={resume}>
          {current?.state === 'item-ended' ? 'Next video' : 'Play'}</button>
        <small>Space: resume</small>
      </div>
    </aside>
    {controller.current?.state === 'error' && <div className="error-panel" role="alert">
      <h2>Playback stopped</h2><p>{controller.current.error}</p>
      <button onClick={() => setRestart(value => value + 1)}>Restart</button> <button onClick={exit}>Return to editor</button>
    </div>}
  </div>;
}
