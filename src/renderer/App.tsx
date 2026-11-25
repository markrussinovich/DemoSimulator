import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { mediaUrl, type Catalog, type Video, type Workspace } from '../shared/model';
import { Player } from './player/Player';
import { Timeline, formatTime } from './editor/Timeline';

async function probe(url: string): Promise<{ duration: number; width: number; height: number }> {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous'; video.preload = 'auto';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Video loading timed out.')), 30000);
    let done = false, discovering = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) reject(error); else resolve({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
      video.onerror = null; video.onloadeddata = null; video.ondurationchange = null; video.ontimeupdate = null;
      video.removeAttribute('src'); video.load();
    };
    video.onerror = () => finish(new Error('Unsupported or corrupt video. Use MP4 (H.264/AAC) or WebM.'));
    const ready = () => {
      if (done || video.readyState < 2) return;
      if (video.duration === Infinity && !discovering) { discovering = true; video.currentTime = 1e10; return; }
      if (discovering && !Number.isFinite(video.duration)) return;
      if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth) finish(new Error('Video duration unavailable. Re-encode as seekable MP4 or WebM.'));
      else finish();
    };
    video.onloadeddata = ready; video.ondurationchange = ready; video.ontimeupdate = ready; video.src = url;
  });
}
const emptyCatalog = (): Catalog => ({ version: 2, videos: [], projects: [] });
export function App() {
  const [document, setDocument] = useState<Workspace | null>(null);
  const [catalog, setCatalog] = useState<Catalog>(emptyCatalog);
  const [saved, setSaved] = useState('');
  const [projectId, setProjectId] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [cueId, setCueId] = useState('');
  const [cueTime, setCueTime] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [busy, setBusy] = useState(true);
  const [session, setSession] = useState<Video[] | null>(null);
  const [fullscreen, setFullscreen] = useState(true);
  const [time, setTime] = useState(0);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [help, setHelp] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesWidth, setNotesWidth] = useState(() => {
    try {
      const width = Number(localStorage.getItem('presenter-notes-width'));
      return Number.isFinite(width) && width >= 220 ? width : 260;
    } catch { return 260; }
  });
  const listArea = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLVideoElement>(null);
  const previewLayout = useRef<HTMLDivElement>(null);
  const notesPanel = useRef<HTMLElement>(null);
  const notesResize = useRef<{ pointer: number; x: number; width: number } | null>(null);
  const helpDialog = useRef<HTMLDialogElement>(null);
  const frameDuration = useRef(1 / 30);
  const previewStart = useRef(0);
  const previewCues = useRef<Video['cues']>([]);
  const operation = useRef(false);
  const draggedVideo = useRef<number | null>(null);
  const project = catalog.projects.find(project => project.id === projectId);
  const videoId = project?.videos[selectedIndex] ?? '';
  const video = catalog.videos.find(video => video.id === videoId);
  previewCues.current = video?.cues ?? [];
  const cue = video?.cues.find(cue => cue.id === cueId);
  const notesCue = video?.cues.filter(point => point.time <= time).at(-1);
  useEffect(() => {
    try { localStorage.setItem('presenter-notes-width', String(notesWidth)); } catch { return; }
  }, [notesWidth]);
  useEffect(() => {
    if (!notesOpen || !previewLayout.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setNotesWidth(width => Math.max(220, Math.min(width, Math.floor(entry.contentRect.width - 172))));
    });
    observer.observe(previewLayout.current);
    return () => observer.disconnect();
  }, [notesOpen, videoId, session]);
  useEffect(() => { setCueTime(cue ? String(cue.time) : ''); }, [cue?.id, cue?.time]);
  useEffect(() => { if (help && !helpDialog.current?.open) helpDialog.current?.showModal(); }, [help]);
  const ordered = project?.videos.map(id => catalog.videos.find(video => video.id === id)!) ?? [];
  useEffect(() => {
    listArea.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, ordered.length, session]);
  const dirty = !!document && (JSON.stringify(catalog) !== saved || !document.filePath);
  const install = (value: Workspace | null, id = value?.projectId ?? value?.catalog.projects[0]?.id ?? '') => {
    setDocument(value); setCatalog(value?.catalog ?? emptyCatalog()); setSaved(value && !value.recovery ? JSON.stringify(value.catalog) : '');
    setProjectId(id); setSelectedIndex(0);
    setCueId(''); setTime(0); setError(value?.recovery ?? ''); setPreviewPlaying(false);
  };
  useEffect(() => {
    window.demo.currentProject().then(value => { if (value) install(value); }).catch(error => setError(String(error))).finally(() => setBusy(false));
    return window.demo.onProgress(setProgress);
  }, []);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirty || busy) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, busy]);
  const checkPreviewCue = (element: HTMLVideoElement, position: number) => {
    if (element.paused || element.seeking) return;
    const point = previewCues.current.find(cue => cue.time > previewStart.current + .0005 && cue.time <= position);
    if (!point) return;
    previewStart.current = point.time;
    element.pause(); element.currentTime = point.time; setTime(point.time);
  };
  useEffect(() => {
    const element = preview.current;
    frameDuration.current = 1 / 30;
    if (!element || session) return;
    let callback: number, previous = -1;
    const frame = (_: number, meta: VideoFrameCallbackMetadata) => {
      const delta = meta.mediaTime - previous;
      if (previous >= 0 && delta > .005 && delta < .2) frameDuration.current = delta;
      previous = meta.mediaTime; setTime(element.currentTime);
      checkPreviewCue(element, meta.mediaTime);
      callback = element.requestVideoFrameCallback(frame);
    };
    callback = element.requestVideoFrameCallback(frame);
    return () => element.cancelVideoFrameCallback(callback);
  }, [videoId, session]);
  const run = async (fn: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(''); preview.current?.pause();
    try { await fn(); } catch (error) { setError(String(error)); }
    finally { setBusy(false); operation.current = false; }
  };
  const save = async (saveAs = false) => {
    if (!project) return false;
    if (!project.name.trim()) throw new Error('Give the project a name before saving.');
    const invalid = ordered.find(video => !video.name.trim() || video.cues.some(cue => !cue.name.trim()));
    if (invalid) throw new Error(`Give the video and each pause point a name before saving (${invalid.name || 'unnamed video'}).`);
    const value = await window.demo.saveProject(catalog, project.id, saveAs);
    if (!value) return false;
    setDocument(value); setSaved(JSON.stringify(catalog)); return true;
  };
  const discard = () => !dirty || window.confirm('Discard unsaved changes to this project?');
  const updateVideo = (change: Partial<Video>) => {
    setCatalog(current => ({ ...current, videos: current.videos.map(video => video.id === videoId ? { ...video, ...change } : video) }));
  };
  const updateNotes = (notes: string | undefined) => {
    if (!video) return;
    if (notesCue) updateVideo({ cues: video.cues.map(point => point.id === notesCue.id ? { ...point, notes } : point) });
    else updateVideo({ notes });
  };
  const resizeNotes = (width: number) => {
    if (!previewLayout.current) return;
    setNotesWidth(Math.max(220, Math.min(Math.floor(previewLayout.current.clientWidth - 172), Math.round(width))));
  };
  const endNotesResize = (event: PointerEvent<HTMLDivElement>) => {
    if (notesResize.current?.pointer !== event.pointerId) return;
    notesResize.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const reorder = (from: number, to: number) => {
    if (!project || from === to || to < 0 || to >= project.videos.length) return;
    const videos = [...project.videos]; videos.splice(to, 0, videos.splice(from, 1)[0]);
    setCatalog(current => ({ ...current, projects: current.projects.map(p => p.id === project.id ? { ...p, videos } : p) }));
    if (selectedIndex === from) setSelectedIndex(to);
    else if (from < selectedIndex && to >= selectedIndex) setSelectedIndex(selectedIndex - 1);
    else if (from > selectedIndex && to <= selectedIndex) setSelectedIndex(selectedIndex + 1);
  };
  const seek = (position: number) => {
    if (!preview.current || !video) return;
    preview.current.pause();
    const next = Math.max(0, Math.min(video.duration - .001, position));
    preview.current.currentTime = next; setTime(next);
  };
  const togglePreview = () => {
    const element = preview.current;
    if (!element || busy) return;
    if (!element.paused) { element.pause(); return; }
    if (element.ended) element.currentTime = 0;
    previewStart.current = element.currentTime;
    void element.play().catch(error => setError(String(error)));
  };
  const removeCue = (id: string) => {
    if (!video) return;
    updateVideo({ cues: video.cues.filter(cue => cue.id !== id) }); setCueId('');
  };
  const moveCue = (id: string, position: number) => {
    if (!video) return;
    const next = Math.round(position * 1000) / 1000;
    if (!Number.isFinite(next) || next <= 0 || next >= video.duration ||
      video.cues.some(cue => cue.id !== id && Math.abs(cue.time - next) < .001)) return;
    updateVideo({ cues: video.cues.map(cue => cue.id === id ? { ...cue, time: next } : cue).sort((a, b) => a.time - b.time) });
    seek(next);
  };
  const addCue = (atTime = preview.current?.currentTime ?? 0) => {
    if (!video || !preview.current) return;
    const position = Math.round(atTime * 1000) / 1000;
    if (position <= 0 || position >= video.duration || video.cues.some(cue => Math.abs(cue.time - position) < .001)) {
      setError('Choose an interior frame without an existing pause point.'); return;
    }
    const point = { id: crypto.randomUUID(), name: `Pause ${video.cues.length + 1}`, time: position };
    updateVideo({ cues: [...video.cues, point].sort((a, b) => a.time - b.time) }); setCueId(point.id); seek(position);
  };
  const newProject = () => run(async () => { if (discard()) install(await window.demo.newProject()); });
  const deleteProject = () => run(async () => {
    if (project && await window.demo.deleteProject(catalog, project.id)) install(await window.demo.currentProject());
  });
  const openProject = (legacy = false) => run(async () => {
    if (!discard()) return;
    const value = legacy ? await window.demo.openLegacyWorkspace() : await window.demo.openProject();
    if (value) install(value);
  });
  const exit = useCallback(() => { setSession(null); setPreviewPlaying(false); void window.demo.fullscreen(false); }, []);
  const play = (items: Video[]) => run(async () => {
    if (!items.length) return;
    // Present the current edit snapshot; saving is a separate, explicit action.
    await window.demo.fullscreen(fullscreen); setSession(structuredClone(items));
  });
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => {
      if (session || busy || !(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === 's') { event.preventDefault(); void run(async () => { await save(event.shiftKey); }); }
      if (event.key.toLowerCase() === 'o') { event.preventDefault(); void openProject(); }
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); void newProject(); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });
  if (session) return <Player projects={session} exit={exit} />;
  return <div className="app-shell" onPointerDownCapture={event => {
    if (!(event.target as HTMLElement).closest('.pause-marker, .cue-inspector, .presenter-notes, .notes-toggle, .notes-resizer')) {
      setCueId('');
      const active = event.currentTarget.ownerDocument.activeElement;
      if (active instanceof HTMLElement && active.matches('.pause-marker')) active.blur();
    }
  }}>
    <header className="app-header">
      <div className="brand"><h1>Demo Simulator</h1><span className="muted">Create once. Present at your pace.</span></div>
      <nav className="file-actions" aria-label="Project files">
        <button disabled={busy} onClick={() => void newProject()} title="Ctrl+N">New project</button>
        <button disabled={busy} onClick={() => void openProject()} title="Ctrl+O">Open project</button>
        <button className="primary" disabled={busy || !project || !dirty} onClick={() => void run(async () => { await save(); })} title="Ctrl+S">Save</button>
        <button disabled={busy || !project} onClick={() => void run(async () => { await save(true); })} title="Ctrl+Shift+S">Save as...</button>
        <button className="danger delete-project" disabled={busy || !project} onClick={() => void deleteProject()}>Delete project</button>
        <button aria-label="Help" aria-expanded={help} onClick={() => setHelp(!help)}>?</button>
      </nav>
    </header>
    {(error || busy || progress) && <div className="notifications">
      {error && <div className="notice error" role="alert"><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}
      {(busy || progress) && <div className="notice" role="status"><span>{progress || 'Loading...'}</span><button onClick={() => void window.demo.cancelOperation()}>Cancel</button></div>}
    </div>}
    {project ? <>
      <div className="project-bar">
        <label className="project-title"><span>Project</span><input aria-label="Project name" value={project.name} disabled={busy} maxLength={200}
          onChange={event => setCatalog(current => ({ ...current, projects: current.projects.map(p => p.id === projectId ? { ...p, name: event.target.value } : p) }))} /></label>
        <span className={`save-status${dirty ? ' unsaved' : ''}`} title={document?.filePath ?? 'Choose a project file with Save'}>{dirty ? 'Unsaved changes' : 'Saved'}{document?.filePath ? ` - ${document.filePath.split(/[\\/]/).pop()}` : ' - choose a file with Save'}</span>
        <button className="primary" disabled={busy || !ordered.length} onClick={() => void play(ordered)}>Play project</button>
        <label className="fullscreen-option">Fullscreen<input aria-label="Fullscreen presentation" type="checkbox" checked={fullscreen} disabled={busy} onChange={event => setFullscreen(event.target.checked)} /></label>
      </div>
      {catalog.projects.length > 1 && <div className="legacy-projects"><label>Recovered project <select aria-label="Recovered project" value={projectId} disabled={busy} onChange={event => {
        preview.current?.pause(); setProjectId(event.target.value); setSelectedIndex(0);
        setDocument(current => current ? { ...current, filePath: undefined } : null);
        setCueId(''); setTime(0);
      }}>{catalog.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><span>Previous playlists are now projects. Save each as a .demosim file.</span></div>}
      <div className="editor-layout">
        <aside className="videos-panel">
          <div className="panel-heading"><h2>Videos <small>{ordered.length}</small></h2><button className="primary" disabled={busy} onClick={() => void run(async () => {
            const imported = await window.demo.importMedia(); if (!imported) return;
            const metadata = await probe(imported.url);
            const added: Video = { id: crypto.randomUUID(), name: imported.name.trim().slice(0, 200) || `Video ${ordered.length + 1}`, media: imported.media, ...metadata, cues: [] };
            setCatalog(current => ({ ...current, videos: [...current.videos, added], projects: current.projects.map(p => p.id === project.id ? { ...p, videos: [...p.videos, added.id] } : p) }));
            setSelectedIndex(ordered.length); setCueId(''); setTime(0);
          })}>Add video</button></div>
          <p className="panel-caption">Playback order. Drag rows to reorder.</p>
          <div className="video-list-area" ref={listArea}>
            <ol className="video-list">
              {ordered.map((item, index) => <li key={`${item.id}-${index}`} draggable={!busy}
                onDragStart={event => { draggedVideo.current = index; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(draggedVideo.current)); }}
                onDragOver={event => { if (!busy && draggedVideo.current !== null) event.preventDefault(); }}
                onDrop={event => { event.preventDefault(); if (!busy && draggedVideo.current !== null) reorder(draggedVideo.current, index); draggedVideo.current = null; }}
                onDragEnd={() => { draggedVideo.current = null; }}>
                <button disabled={busy} className={selectedIndex === index ? 'selected' : ''} aria-current={selectedIndex === index ? 'true' : undefined}
                  onClick={() => { preview.current?.pause(); if (videoId === item.id) seek(0); setSelectedIndex(index); setCueId(''); setTime(0); setPreviewPlaying(false); }}>
                  <span className="video-number">{index + 1}</span>
                  <span className="video-description"><strong title={item.name}>{item.name}</strong><small>{formatTime(item.duration)} &middot; {item.cues.length} pauses</small></span>
                </button>
              </li>)}
            </ol>
            {!ordered.length && <div className="list-empty">Add your cursor-free MP4 or WebM videos to this project.</div>}
          </div>
          <div className="video-actions">
            <button disabled={busy || !video || selectedIndex <= 0} onClick={() => reorder(selectedIndex, selectedIndex - 1)}>Move up</button>
            <button disabled={busy || !video || selectedIndex === ordered.length - 1} onClick={() => reorder(selectedIndex, selectedIndex + 1)}>Move down</button>
            <button className="danger" disabled={busy || !video} onClick={() => {
              if (!window.confirm(`Remove "${video!.name}" from this project?`)) return;
              const next = project.videos.filter((_, index) => index !== selectedIndex);
              setCatalog(current => {
                const projects = current.projects.map(p => p.id === project.id ? { ...p, videos: next } : p);
                const referenced = new Set(projects.flatMap(p => p.videos));
                return { ...current, projects, videos: current.videos.filter(video => referenced.has(video.id)) };
              });
              setSelectedIndex(Math.max(0, Math.min(selectedIndex, next.length - 1))); setCueId(''); setTime(0);
            }}>Remove video</button>
          </div>
        </aside>
        <main className="editor-panel">
          {video ? <>
            <div className="video-heading"><button disabled={busy} onClick={() => void play([video])}>Play this video</button>
              <label><span>Video {selectedIndex + 1}</span><input aria-label="Video name" value={video.name} disabled={busy} maxLength={200} onChange={event => updateVideo({ name: event.target.value })} /></label>
              <button className="notes-toggle" disabled={busy} aria-expanded={notesOpen} aria-controls="presenter-notes" onClick={() => setNotesOpen(!notesOpen)}>Presenter notes</button></div>
            <div className="preview-layout" ref={previewLayout}>
              <div className="preview-area"><video key={video.media} className="preview" crossOrigin="anonymous" ref={preview} src={mediaUrl(video.media)} muted disablePictureInPicture
              onClick={togglePreview}
              onTimeUpdate={event => { checkPreviewCue(event.currentTarget, event.currentTarget.currentTime); setTime(event.currentTarget.currentTime); }} onSeeked={event => setTime(event.currentTarget.currentTime)}
              onPlay={() => setPreviewPlaying(true)} onPause={() => setPreviewPlaying(false)} onEnded={() => setPreviewPlaying(false)}
              onError={() => setError('Video unavailable or unsupported. Restore the media or add the recording again.')} /></div>
              {notesOpen && <>
                <div className="notes-resizer" role="separator" aria-label="Resize presenter notes" aria-orientation="vertical"
                  aria-valuemin={220} aria-valuenow={notesWidth} aria-disabled={busy} tabIndex={busy ? -1 : 0}
                  onPointerDown={event => {
                    if (busy || event.button !== 0 || !notesPanel.current) return;
                    event.preventDefault();
                    notesResize.current = { pointer: event.pointerId, x: event.clientX, width: notesPanel.current.getBoundingClientRect().width };
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }} onPointerMove={event => {
                    const drag = notesResize.current;
                    if (drag?.pointer === event.pointerId) resizeNotes(drag.width + drag.x - event.clientX);
                  }} onPointerUp={endNotesResize} onPointerCancel={endNotesResize} onLostPointerCapture={endNotesResize}
                  onKeyDown={event => {
                    if (busy) return;
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    resizeNotes(event.key === 'Home' ? 220 : event.key === 'End' ? Infinity : notesWidth + (event.key === 'ArrowLeft' ? 16 : -16));
                  }} />
                <aside className="presenter-notes" id="presenter-notes" aria-label="Presenter notes" ref={notesPanel} style={{ width: notesWidth }}>
                <div className="notes-toolbar">
                  <select aria-label="Notes for" title="Notes follow the playhead. Choose an entry to seek." value={notesCue?.id ?? ''} disabled={busy} onChange={event => {
                    setCueId(event.target.value);
                    const point = video.cues.find(point => point.id === event.target.value); seek(point?.time ?? 0);
                  }}><option value="">Video default</option>{video.cues.map((point, index) => <option key={point.id} value={point.id}>{index + 1}. {point.name}</option>)}</select>
                  <button disabled={busy} aria-label="Close presenter notes" onClick={() => setNotesOpen(false)}>Close</button>
                </div>
                <label className="notes-inherit" aria-hidden={!notesCue}><input type="checkbox" checked={notesCue?.notes === undefined} disabled={busy || !notesCue}
                  onChange={event => updateNotes(event.target.checked ? undefined : video.notes ?? '')} /><span>Use video default</span></label>
                <textarea aria-label="Presenter notes" disabled={busy} value={notesCue?.notes ?? video.notes ?? ''}
                  placeholder="Talking points and reminders..." onChange={event => updateNotes(event.target.value)} />
                <p className="notes-hint">{!notesCue ? 'Default notes for all pause points.' : notesCue.notes === undefined ? 'Type here to customize this pause.' : 'These notes apply only to this pause.'}</p>
                </aside>
              </>}
            </div>
            <Timeline duration={video.duration} time={time} cues={video.cues} selected={cueId} disabled={busy} select={setCueId} seek={seek} add={addCue} move={moveCue} remove={removeCue} />
            <div className="transport">
              <button disabled={busy} aria-label="Reset" title="Reset to beginning" onClick={() => seek(0)}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M1 1h3v14H1zm14 0L5 8l10 7z" /></svg></button>
              <button disabled={busy} aria-label={previewPlaying ? 'Pause preview' : 'Play preview'} title={previewPlaying ? 'Pause' : 'Play'} onClick={togglePreview}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">{previewPlaying
                ? <path fill="currentColor" d="M2 1h4v14H2zm8 0h4v14h-4z" />
                : <path fill="currentColor" d="m2 1 12 7-12 7z" />}</svg></button>
              <button disabled={busy} aria-label="Previous frame" onClick={() => seek(time - frameDuration.current)} title="Previous frame (approximate)"><svg width="10" height="12" viewBox="0 0 12 14" aria-hidden="true"><path fill="currentColor" d="M12 0 0 7l12 7z" /></svg><span>1 Frame</span></button>
              <button disabled={busy} aria-label="Next frame" onClick={() => seek(time + frameDuration.current)} title="Next frame (approximate)"><span>1 Frame</span><svg width="10" height="12" viewBox="0 0 12 14" aria-hidden="true"><path fill="currentColor" d="m0 0 12 7-12 7z" /></svg></button>
              <output aria-label="Current video time">{formatTime(time)} / {formatTime(video.duration)}</output>
              <button className="primary" disabled={busy} onClick={() => addCue()}>Add pause point</button>
            </div>
            <div className="cue-inspector">
              <label className="cue-picker"><span>Pause point</span><select aria-label="Selected pause point" disabled={busy || !video.cues.length} value={cue?.id ?? ''} onChange={event => {
                setCueId(event.target.value); const point = video.cues.find(cue => cue.id === event.target.value); if (point) seek(point.time);
              }}><option value="">Select a marker</option>{video.cues.map((cue, index) => <option key={cue.id} value={cue.id}>{index + 1}. {cue.name}</option>)}</select></label>
              {cue ? <>
                <label className="cue-name"><span>Name</span><input aria-label="Pause name" disabled={busy} value={cue.name} maxLength={200} onChange={event => updateVideo({ cues: video.cues.map(point => point.id === cue.id ? { ...point, name: event.target.value } : point) })} /></label>
                <label className="cue-time"><span>Seconds</span><input aria-label="Pause time" disabled={busy} type="number" step=".001" min=".001" max={video.duration - .001} value={cueTime}
                  onChange={event => { setCueTime(event.target.value); if (event.target.value) moveCue(cue.id, Number(event.target.value)); }}
                  onBlur={() => setCueTime(String(cue.time))} /></label>
                <button disabled={busy} className="danger" onClick={() => removeCue(cue.id)}>Delete pause</button>
              </> : <p className="cue-hint">Add a pause at the playhead, or select a timeline marker to edit it.</p>}
            </div>
          </> : <div className="empty"><h2>Add your first video</h2><p>A project contains all the videos in your demo, in playback order.<br />Use Add video to start, then place pause points on the timeline.</p></div>}
        </main>
      </div>
      <footer><span>Space: pause/resume &middot; Ctrl+Space: playback controls &middot; Esc: editor</span><span title={document?.filePath}>{document?.filePath ? 'Project file includes videos' : 'Save creates one portable project file'}</span></footer>
    </> : !busy && <main className="welcome"><div><h2>Your demo, one project.</h2><p>Add videos, arrange them, and place pauses.<br />Move your real mouse while presenting at your own pace.</p>
      <div className="row"><button className="primary" disabled={busy} onClick={() => void newProject()}>Create a project</button><button disabled={busy} onClick={() => void openProject()}>Open a project file</button></div>
      <p className="muted">One .demosim file holds your videos, their order, and all pause points.</p>
      <button className="text-button" disabled={busy} onClick={() => void openProject(true)}>Open a previous-version workspace...</button>
    </div></main>}
    {help && <dialog className="help-dialog" ref={helpDialog} aria-label="Quick guide" onClose={() => setHelp(false)}>
      <div className="panel-heading"><h2>Quick guide</h2><button onClick={() => setHelp(false)} aria-label="Close help">Close</button></div>
      <p><strong>New / Open / Save / Save as</strong> work with a single .demosim project file. It includes all videos; no workspace setup or separate playlist is needed.</p>
      <p>Add videos and drag their rows to reorder. Use the timeline to scrub; double-click it to add a pause point. Drag a numbered marker to change its time, or drag it away from the track to delete it. Select a marker to name it or type its exact time.</p>
      <p>Marker keyboard: Left/Right moves 33 ms; Shift moves 1 second; Delete removes it. Escape cancels a marker drag. Frame stepping is approximate.</p>
      <p>Play/Pause or clicking the preview controls editor playback, including authored pauses. Reset stops and returns to the beginning. Arrowheads step approximately one frame. Click outside a marker or its inspector to clear the selection.</p>
      <p>Presenter notes opens the notes editor beside the video. Drag its left divider to resize; the width is remembered across runs. Notes follow the latest pause reached by the playhead, or Video default before the first pause. Choose a notes entry to seek to it; type to customize a pause, or check Use video default to reset it. Notes are saved in the project file and hidden by default during presentation.</p>
      <p>Play project starts with the first video paused. Space pauses/resumes; Enter or click resumes. At the end, Space loads the next video paused, and another Space starts it. Switching away pauses. Escape returns to the editor.</p>
      <p>Ctrl+Space pauses and slides open playback controls. Scrub the timeline, choose a pause, go to the previous pause, or return to the start. Play or Space resumes and hides the controls. Ctrl+Space closes them without resuming.</p>
      <p>During presentation, hold the mouse at the bottom edge for one second to open the timeline, or at the right edge to show the matching notes. Either pauses playback. Hover-opened panels hide when the pointer leaves, without resuming. Play or Space resumes and hides them. Opened notes are visible on the presentation screen.</p>
      <p className="muted">Use cursor-free recordings. Recorded-cursor removal is not included.</p>
      <button className="text-button" disabled={busy} onClick={() => { setHelp(false); void openProject(true); }}>Open a previous-version workspace...</button>
    </dialog>}
  </div>;
}
