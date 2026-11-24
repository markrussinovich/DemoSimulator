import { useEffect, useRef, useState } from 'react';
import { mediaUrl, type Video } from '../../shared/model';
import { PlaybackController } from './controller';

export function Player({ projects, exit }: { projects: Video[]; exit: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const controller = useRef<PlaybackController | null>(null);
  const [, render] = useState(0);
  const [cover, setCover] = useState('');
  const [restart, setRestart] = useState(0);
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
      if (event.code === 'Escape') { event.preventDefault(); exit(); }
      if (event.code === 'Space' || event.code === 'Enter') {
        event.preventDefault(); void c.input(event.code === 'Space' ? 'space' : 'enter');
      }
    };
    const blur = () => c.blur();
    const focus = () => c.refocus();
    window.addEventListener('keydown', key); window.addEventListener('blur', blur); window.addEventListener('focus', focus);
    const unsubscribe = window.demo.onFullscreen(enabled => { if (!enabled) exit(); });
    const unsubscribeFocus = window.demo.onFocus(focused => { if (focused) c.refocus(); else c.blur(); });
    c.start();
    return () => {
      c.dispose(); controller.current = null; unsubscribe(); unsubscribeFocus();
      window.removeEventListener('keydown', key); window.removeEventListener('blur', blur); window.removeEventListener('focus', focus);
    };
  }, [projects, exit, restart]);
  return <div className="stage" data-testid="stage" data-state={controller.current?.state ?? 'loading'} data-index={controller.current?.index ?? 0} data-overshoot={controller.current?.lastOvershoot ?? 0}>
    <video ref={video} crossOrigin="anonymous" onClick={event => { if (event.button === 0) void controller.current?.input('click'); }} muted disablePictureInPicture />
    {cover && <img className="cover" src={cover} alt="" />}
    {controller.current?.state === 'error' && <div className="error-panel" role="alert">
      <h2>Playback stopped</h2><p>{controller.current.error}</p>
      <button onClick={() => setRestart(value => value + 1)}>Restart</button> <button onClick={exit}>Return to editor</button>
    </div>}
  </div>;
}
