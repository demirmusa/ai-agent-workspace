import { aiProviders } from '../ai-providers/index.js';
import { effectiveProviderSettings } from '../provider-settings.js';
import type { RuntimeHandle } from '../runner.js';
import type { ControlState, Run, TaskOrganization } from '../types.js';
import { activeMs, runEnded } from './common.js';

const aiProviderInfo = aiProviders.info();

export interface StateViewSources {
  handles: ReadonlyMap<string, RuntimeHandle>;
  planningAgents: ReadonlySet<string>;
  organizations: ReadonlyMap<string, TaskOrganization>;
  draining: () => boolean;
}

/** Whether each agent profile can take work now, and the run or planning request that holds it. */
export function agentAvailability(state: ControlState, sources: Pick<StateViewSources, 'handles' | 'planningAgents'>): NonNullable<ControlState['agentAvailability']> {
  const busyAgents = new Map<string, Run>();
  for (const run of state.runs) { const agentId = run.executionSnapshot?.agent?.id; if (agentId && !busyAgents.has(agentId) && (!runEnded(run) || sources.handles.has(run.id))) busyAgents.set(agentId, run); }
  return Object.fromEntries(state.agents.map((agent) => {
    const run = busyAgents.get(agent.id), planning = sources.planningAgents.has(agent.id);
    return [agent.id, { available: agent.enabled && !run && !planning, runId: run?.id ?? null, status: !agent.enabled ? 'disabled' : run?.status ?? (planning ? 'planning' : 'available') }];
  }));
}

/**
 * A JSON-ready view sharing objects with the live state: serialize it at once.
 * Terminal replays are never part of the state; they stream separately.
 */
export function stateView(state: ControlState, sources: StateViewSources, includeJournal = true): ControlState {
  const current = Date.now();
  const runs = state.runs.map(({ terminalOutput: _output, ...run }) => ({ ...run, activeMs: activeMs(run, current) }));
  // Project terminals are listed per project (GET /api/projects/:id/terminals), not as part of the state.
  const { events: _events, messages: _messages, terminals: _terminals, ...rest } = state;
  return { ...rest, ...(includeJournal ? { events: state.events, messages: state.messages } : {}), runs, agentAvailability: agentAvailability(state, sources),
    resolvedProviderSettings: Object.fromEntries([...state.projects, ...(state.generalWorkspace ? [state.generalWorkspace] : [])].filter((project) => project.providerSettings).map((project) => [project.id, effectiveProviderSettings(state.settings, project)])),
    organizations: Object.fromEntries(sources.organizations), aiProviders: aiProviderInfo,
    systemStatus: state.settings.systemEnabled ? 'running' : sources.draining() ? 'draining' : 'stopped' } as ControlState;
}
