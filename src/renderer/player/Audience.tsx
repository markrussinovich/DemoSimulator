import { useCallback, useEffect, useState } from 'react';
import type { PlaybackResult, PresentationSession } from '../../shared/model';
import { Player } from './Player';

export function Audience() {
  const [session, setSession] = useState<PresentationSession | null>(null);
  useEffect(() => { void window.demo.currentPresentation().then(setSession); }, []);
  const exit = useCallback((result: PlaybackResult) => {
    if (session) void window.demo.finishPresentation(session.id, result);
  }, [session]);
  return session ? <Player projects={session.videos} audienceId={session.id} initialFocus={session.focused} exit={exit} /> : <div className="stage" />;
}
