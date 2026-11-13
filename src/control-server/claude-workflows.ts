import type { AgentExecutionStatus } from './types.js';

/** Claude Code files a Workflow tool run under `<session>/subagents/workflows/<run id>`: its agents' transcripts and a journal of their steps. */
export const WORKFLOW_RUN_ID = /^wf_[a-zA-Z0-9_-]{1,200}$/;
export const workflowNodeId = (runId: string): string => `claude:workflow:${runId}`;
const LITERAL = String.raw`(['"\`])((?:\\.|(?!\1)[^\\])*)\1`;
const literal = (block: string, key: string): string | undefined => {
  const value = new RegExp(String.raw`\b${key}\s*:\s*${LITERAL}`, 's').exec(block)?.[2];
  return value?.replace(/\\(.)/gs, '$1');
};

export interface WorkflowPhase { title: string; detail?: string }
export interface WorkflowScriptMeta { name?: string; description?: string; phases: WorkflowPhase[] }
/** The name, description and steps a script declares in `export const meta`, which is a pure literal; the script itself is never run. */
export function workflowScriptMeta(source: string): WorkflowScriptMeta {
  const start = source.indexOf('export const meta'); if (start < 0) return { phases: [] };
  const head = source.slice(start), list = /\bphases\s*:\s*\[/.exec(head);
  // The steps are read apart so that their titles cannot stand in for the workflow's own fields.
  const end = list ? head.indexOf(']', list.index) : -1, own = list ? head.slice(0, list.index) : head.slice(0, head.indexOf('}') + 1 || undefined);
  const phases = list && end >= 0 ? [...head.slice(list.index, end).matchAll(/\{[^{}]*\}/g)].flatMap(([block]) => { const title = literal(block, 'title'), detail = literal(block, 'detail'); return title ? [{ title, ...(detail ? { detail } : {}) }] : []; }) : [];
  const name = literal(own, 'name'), description = literal(own, 'description');
  return { ...(name ? { name } : {}), ...(description ? { description } : {}), phases };
}

export interface WorkflowJournal { order: string[]; phases: string[]; labels: Map<string, string>; phaseOf: Map<string, string>; results: Set<string> }
/** The agents a run's journal started, in order, and those with a recorded result. */
export function workflowJournal(rows: any[]): WorkflowJournal {
  const journal: WorkflowJournal = { order: [], phases: [], labels: new Map(), phaseOf: new Map(), results: new Set() };
  for (const row of rows) {
    if (typeof row?.agentId !== 'string') continue;
    if (row.type === 'result') journal.results.add(row.agentId);
    if (row.type !== 'started') continue;
    if (!journal.order.includes(row.agentId)) journal.order.push(row.agentId);
    if (typeof row.label === 'string') journal.labels.set(row.agentId, row.label);
    if (typeof row.phase === 'string') { journal.phaseOf.set(row.agentId, row.phase); if (!journal.phases.includes(row.phase)) journal.phases.push(row.phase); }
  }
  return journal;
}

export interface WorkflowLaunch { runId: string; toolUseId?: string; taskId?: string; name?: string; summary?: string; at?: string }
export interface WorkflowEnd { status: AgentExecutionStatus; at?: string }
const NOTIFICATION = /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g;
const contentText = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part?.type === 'text' && typeof part.text === 'string' ? part.text : '').join('\n') : '';
/** The launches and task endings a session's own rows report; `readStatus` maps the provider's status words. */
export function workflowEvents(rows: any[], readStatus: (value: unknown) => AgentExecutionStatus): { launches: Map<string, WorkflowLaunch>; ends: Map<string, WorkflowEnd> } {
  const launches = new Map<string, WorkflowLaunch>(), ends = new Map<string, WorkflowEnd>();
  const end = (id: unknown, value: unknown, at: unknown): void => { const next = readStatus(value); if (typeof id === 'string' && next !== 'unknown') ends.set(id, { status: next, ...(typeof at === 'string' ? { at } : {}) }); };
  for (const row of rows) {
    // A transcript file and the live stream spell the tool's structured result differently.
    const launched = row?.toolUseResult ?? row?.tool_use_result;
    if (launched?.taskType === 'local_workflow' && WORKFLOW_RUN_ID.test(launched.runId ?? '')) {
      const toolUseId = (Array.isArray(row.message?.content) ? row.message.content : []).find((part: any) => part?.type === 'tool_result')?.tool_use_id;
      launches.set(launched.runId, { runId: launched.runId, ...(typeof toolUseId === 'string' ? { toolUseId } : {}), ...(typeof launched.taskId === 'string' ? { taskId: launched.taskId } : {}), ...(typeof launched.workflowName === 'string' ? { name: launched.workflowName } : {}), ...(typeof launched.summary === 'string' ? { summary: launched.summary } : {}), ...(typeof row.timestamp === 'string' ? { at: row.timestamp } : {}) });
    }
    if (row?.type === 'system' && row.subtype === 'task_notification') end(row.task_id, row.status, row.timestamp);
    if (row?.type === 'system' && row.subtype === 'task_updated') end(row.task_id, row.patch?.status, row.timestamp);
    if (row?.type === 'user') for (const match of contentText(row.message?.content).matchAll(NOTIFICATION)) end(match[1], match[2], row.timestamp);
  }
  return { launches, ends };
}
