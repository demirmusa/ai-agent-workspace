import { join } from 'node:path';
import type { HistoryPointer, SessionHistory } from '../history.js';
import { transferTranscript } from '../history-transfer.js';
import type { HistoryProvider, Project, Run, SessionHistoryDetail } from '../types.js';

const MAX_PAGES = 500, PAGE_SIZE = 200;

/** The provider session file of a run: its recorded session, else the one its bootstrap prompt started. */
export async function runSessionPointer(history: SessionHistory, project: Project, run: Run, provider: HistoryProvider): Promise<HistoryPointer | null> {
  return (run.sessionId ? await history.findSession(project, provider, run.sessionId) : null) ?? await bootstrapPointer(history, project, run, provider);
}
/** The provider session that the run's prompt file started, unless several sessions match it. */
export async function bootstrapPointer(history: SessionHistory, project: Project, run: Run, provider: HistoryProvider): Promise<HistoryPointer | null> {
  if (!run.inputDirectory) return null;
  const found = await history.findBootstrap(project, provider, join(run.inputDirectory, 'prompt.md'), run.startedAt);
  return found.ambiguous ? null : found.pointer;
}

/** Reads a provider session page by page; false when it has more pages than the read limit. */
export async function readSessionPages(history: SessionHistory, pointer: HistoryPointer, onPage: (page: SessionHistoryDetail) => void): Promise<boolean> {
  let cursor: string | null = null, pages = 0;
  do {
    const page = await history.readPointer(pointer, { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
    onPage(page); cursor = page.nextCursor;
  } while (cursor && ++pages < MAX_PAGES);
  return !cursor;
}

/** Appends a provider session's history as readable transcript records; false when it has more pages than are read. */
export function readSessionTranscript(history: SessionHistory, pointer: HistoryPointer, append: (record: string) => void): Promise<boolean> {
  return readSessionPages(history, pointer, (page) => {
    for (const message of page.messages) append(`[${message.authorType}] ${message.text}`);
    for (const event of page.events) {
      const formatted = event.type === 'stdout' ? transferTranscript([], [{ ...event, id: event.id ?? 'event', createdAt: event.createdAt ?? '' }]) : '';
      append(formatted || `[${event.type}] ${event.message}`);
    }
    for (const warning of page.warnings) append(`[History warning] ${warning}`);
    if (page.truncated && !page.nextCursor) append('[History warning] Provider history contains shortened or omitted records.');
  });
}
