import { join } from 'node:path';
import { ErrorLog } from '../control-server/error-log.js';
import { readJsonFile, writeJsonFileAtomic } from '../shared/core/json.js';
import { defaultControlDataDir } from '../shared/core/paths.js';
import { windows } from './window-registry.js';

export type ZoomChange = 'in' | 'out' | 'reset';
const MIN_PERCENT = 50, MAX_PERCENT = 200, STEP_PERCENT = 10, DEFAULT_PERCENT = 100;

let percent: number | null = null;
let writes: Promise<void> = Promise.resolve();
const zoomFile = (): string => join(defaultControlDataDir(), 'desktop-zoom.json');
const valid = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= MIN_PERCENT && value <= MAX_PERCENT;

/** The saved level, read once; a missing or invalid file means the default. */
export async function loadZoom(): Promise<number> {
  if (percent !== null) return percent;
  const saved = await readJsonFile<{ percent?: unknown }>(zoomFile()).catch(() => null);
  percent ??= valid(saved?.percent) ? saved.percent : DEFAULT_PERCENT;
  return percent;
}

export const zoomFactor = (value: number): number => value / 100;
export const zoomState = (value: number) => ({ percent: value, min: MIN_PERCENT, max: MAX_PERCENT, default: DEFAULT_PERCENT });

/** Applies the change to every window at once and saves it; writes run in order so the last level wins. */
export async function changeZoom(change: ZoomChange): Promise<ReturnType<typeof zoomState>> {
  const current = await loadZoom();
  const next = change === 'reset' ? DEFAULT_PERCENT : Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, current + (change === 'in' ? STEP_PERCENT : -STEP_PERCENT)));
  percent = next;
  const state = zoomState(next);
  for (const window of windows) {
    if (window.isDestroyed()) continue;
    window.webContents.setZoomFactor(zoomFactor(next));
    window.webContents.send('aiws:zoom-changed', state);
  }
  const file = zoomFile();
  writes = writes.then(() => writeJsonFileAtomic(file, { percent: next })).catch((error: unknown) => {
    new ErrorLog(defaultControlDataDir()).write({ source: 'desktop', message: `Could not save the zoom level: ${error instanceof Error ? error.message : String(error)}` });
  });
  await writes;
  return state;
}

/** The zoom change of a key press. It reads the produced character, so + works on layouts where it needs Shift (Turkish Q: Shift+4). */
export function zoomShortcut(input: { type: string; control: boolean; meta: boolean; alt: boolean; key: string }): ZoomChange | null {
  if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return null;
  if (input.key === '+' || input.key === '=') return 'in';
  if (input.key === '-') return 'out';
  return input.key === '0' ? 'reset' : null;
}
