import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Cue } from '../../shared/model';

type Props = {
  duration: number; time: number; cues: Cue[]; selected: string; disabled: boolean;
  select: (id: string) => void; seek: (time: number) => void;
  add: (time: number) => void;
  move: (id: string, time: number) => void; remove: (id: string) => void;
};
export const formatTime = (time: number) => {
  const milliseconds = Math.round(time * 1000);
  const minutes = Math.floor(milliseconds / 60000);
  return `${minutes}:${((milliseconds % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
};
export function Timeline({ duration, time, cues, selected, disabled, select, seek, add, move, remove }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; original: number; pointer: number; x: number; y: number; moved: boolean } | null>(null);
  const scrub = useRef<number | null>(null);
  const [outside, setOutside] = useState(false);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(track.current!); return () => observer.disconnect();
  }, []);
  const position = (x: number) => {
    const rect = track.current!.getBoundingClientRect();
    return Math.max(.001, Math.min(duration - .001, Math.round((x - rect.left) / rect.width * duration * 1000) / 1000));
  };
  const offTrack = (event: PointerEvent) => {
    const rect = track.current!.getBoundingClientRect();
    return event.clientY < rect.top - 24 || event.clientY > rect.bottom + 24 ||
      event.clientX < rect.left - 24 || event.clientX > rect.right + 24;
  };
  const moveMarker = (event: PointerEvent) => {
    if (!drag.current || event.pointerId !== drag.current.pointer) return;
    if (Math.hypot(event.clientX - drag.current.x, event.clientY - drag.current.y) >= 3) drag.current.moved = true;
    if (!drag.current.moved) return;
    const off = offTrack(event); setOutside(off);
    if (!off) move(drag.current.id, position(event.clientX));
  };
  const cancel = () => {
    if (drag.current) move(drag.current.id, drag.current.original);
    drag.current = null; setOutside(false);
  };
  const endScrub = (event: PointerEvent<HTMLDivElement>) => {
    if (scrub.current !== event.pointerId) return;
    scrub.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const keys = (event: KeyboardEvent, cue?: Cue) => {
    if (disabled) return;
    if (event.key === 'Escape' && drag.current) { event.preventDefault(); cancel(); return; }
    if (cue && ['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); remove(cue.id); return; }
    const delta = event.shiftKey ? 1 : .033;
    let value = cue?.time ?? time;
    if (event.key === 'ArrowLeft') value -= delta;
    else if (event.key === 'ArrowRight') value += delta;
    else if (event.key === 'Home') value = cue ? .001 : 0;
    else if (event.key === 'End') value = duration - .001;
    else return;
    event.preventDefault(); value = Math.max(cue ? .001 : 0, Math.min(duration - .001, value));
    if (cue) move(cue.id, Math.round(value * 1000) / 1000); else seek(value);
  };
  return <div className={`timeline-panel${outside ? ' deleting' : ''}`} aria-label="Video timeline">
    <div className="timeline-help"><span>Pause points: double-click to add; drag to move/delete</span><span>{outside ? 'Release to delete pause point' : `${cues.length} pause point${cues.length === 1 ? '' : 's'}`}</span></div>
    <div className="timeline-track" ref={track} data-testid="timeline" onPointerDown={event => {
      if (disabled || event.button !== 0 || (event.target as HTMLElement).closest('.pause-marker')) return;
      event.preventDefault();
      scrub.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId);
      seek(position(event.clientX));
    }} onPointerMove={event => { if (scrub.current === event.pointerId) seek(position(event.clientX)); }}
    onPointerUp={event => { if (scrub.current === event.pointerId) { endScrub(event); seek(position(event.clientX)); } }}
    onPointerCancel={endScrub} onLostPointerCapture={endScrub} onDragStart={event => event.preventDefault()}
    onDoubleClick={event => {
      if (disabled || event.button !== 0 || (event.target as HTMLElement).closest('.pause-marker')) return;
      event.preventDefault(); add(position(event.clientX));
    }}>
      <div className="timeline-rail" /><div className="timeline-fill" style={{ width: `${time / duration * 100}%` }} />
      <div className="playhead" role="slider" aria-label="Video position" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={time}
        aria-valuetext={formatTime(time)} aria-disabled={disabled} tabIndex={disabled ? -1 : 0} style={{ left: `${time / duration * 100}%` }} onKeyDown={event => keys(event)} />
      {cues.map((cue, index) => {
        const distance = Math.min(index > 0 ? cue.time - cues[index - 1].time : Infinity, index + 1 < cues.length ? cues[index + 1].time - cue.time : Infinity);
        const markerWidth = Math.min(24, Math.max(4, distance / duration * width - 2));
        return <button key={cue.id} role="slider" aria-label={`Pause point ${index + 1}: ${cue.name}`}
        aria-valuemin={.001} aria-valuemax={duration - .001} aria-valuenow={cue.time} aria-valuetext={formatTime(cue.time)}
        title={`${cue.name} - ${formatTime(cue.time)}. Drag to move; drag off to delete.`}
        className={`pause-marker${selected === cue.id ? ' selected' : ''}${drag.current?.id === cue.id && outside ? ' removing' : ''}`}
        style={{ left: `${cue.time / duration * 100}%`, width: markerWidth }} disabled={disabled}
        onKeyDown={event => keys(event, cue)} onPointerDown={event => {
          if (event.button !== 0) return;
          event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: cue.id, original: cue.time, pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
          select(cue.id); seek(cue.time);
        }} onPointerMove={moveMarker} onPointerUp={event => {
          if (!drag.current || event.pointerId !== drag.current.pointer) return;
          event.stopPropagation();
          if (drag.current.moved) {
            if (offTrack(event)) remove(drag.current.id); else move(drag.current.id, position(event.clientX));
          }
          drag.current = null; setOutside(false);
        }} onPointerCancel={cancel} onLostPointerCapture={() => { if (drag.current) cancel(); }}>
        {markerWidth >= 18 && <span>{index + 1}</span>}
      </button>;
      })}
    </div>
    <div className="timeline-labels"><span>0:00</span><span>{formatTime(duration)}</span></div>
  </div>;
}
