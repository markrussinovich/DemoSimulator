import { describe, expect, it } from 'vitest';
import { formatTime } from '../src/renderer/editor/Timeline';

describe('timeline timestamps', () => {
  it('carries rounded milliseconds into the next minute', () => {
    expect(formatTime(59.9994)).toBe('0:59.999');
    expect(formatTime(59.9996)).toBe('1:00.000');
    expect(formatTime(3599.9996)).toBe('60:00.000');
  });
});
