import { aiProviders } from '../ai-providers/index.js';
import { draftTask, draftTasks, organizeTasks, planningActivity, planTasks } from '../assistant.js';
import type { ControlCatalog } from '../catalog.js';
import { ControlError, type AgentDefinition, type Provider, type ProviderArgs, type Task, type TaskOrganization } from '../types.js';
import { jsonObject } from '../validation.js';
import { newId, now, text } from './common.js';
import type { ControlContext } from './context.js';
import { agentAvailability } from './state-view.js';

export interface AssistantDependencies {
  catalog: ControlCatalog;
  emit(event: 'draft' | 'organize', payload: unknown): void;
  createTask(input: unknown): Task;
  launchProviderArgs(projectId: string): ProviderArgs;
  /** Where agents reach the control API. */
  connection(): { url: string; token: string | undefined };
}

/** Streams planning output lines; complete ones are passed on, a partial line waits for the next chunk. */
function lineReader(onLine: (line: string) => void): (stream: 'stdout' | 'stderr', output: string) => void {
  let pending = '';
  return (stream, output) => {
    if (stream !== 'stdout') return; const lines = `${pending}${output}`.split(/\r?\n/); pending = (lines.pop() ?? '').slice(-200_000);
    for (const line of lines) onLine(line);
  };
}

/** AI requests that work without a board task: the project planner chat, task drafts and the task-queue organizer. */
export class AssistantRequests {
  private planning = new Set<string>();
  private planningAbort = new Map<string, AbortController>();
  /** Agent profiles held by a running planning or draft request. */
  readonly planningAgents = new Set<string>();
  private draftRequests = new Map<string, string>();
  private organizing = new Map<string, { requestId: string; abort: AbortController }>();
  readonly organizations = new Map<string, TaskOrganization>();
  constructor(private readonly ctx: ControlContext, private readonly deps: AssistantDependencies) {}

  /** Some planning or organizing request is still running. */
  busy(): boolean { return this.planning.size > 0 || this.organizing.size > 0; }
  forget(projectId: string): void { this.organizations.delete(projectId); }
  async plan(projectId: string, input: unknown): Promise<{ reply: string; tasks: Task[] }> {
    const { ctx, deps } = this, state = ctx.state;
    this.assertEnabled();
    const project = ctx.project(projectId); if (this.planning.has(projectId)) throw new ControlError('Planning is already running for this project.', 409);
    const value = jsonObject(input); const message = text(value.message, 'message', 30000).trim(); if (!message) throw new ControlError('Planning message is required.');
    const settings = ctx.providerSettings(projectId);
    const agent = this.agent(value, settings.defaultProvider, 'Planning agent is disabled.', 'Planning agent is busy.');
    const abort = new AbortController(); this.planningAbort.set(projectId, abort);
    if (agent) this.planningAgents.add(agent.id);
    state.plannerMessages.push({ id: newId('chat'), projectId, role: 'user', text: message, createdAt: now() }); ctx.changed(); this.planning.add(projectId);
    try {
      const { url, token } = deps.connection();
      const result = await planTasks(project, agent, agent ? agent.skillIds.map((skillId) => deps.catalog.skill(skillId)) : [], state.plannerMessages.filter((item) => item.projectId === projectId).slice(-40), {
        agents: state.agents, workflows: state.workflows, dataDir: ctx.store.directory, defaultProvider: settings.defaultProvider, defaultModels: settings.defaultModels,
        signal: abort.signal,
        executionMode: state.settings.executionMode, image: state.settings.dockerImage, providerArgs: deps.launchProviderArgs(project.id), controlUrl: process.env.AIWS_CONTROL_AGENT_URL ?? url,
        ...(token ? { token } : {}), onOutput: (_stream, output) => { if (!ctx.closing) { ctx.event(null, null, 'planner.output', output, { projectId }); ctx.changed(); } },
      });
      if (ctx.closing) throw new ControlError('Service is stopping.', 503);
      const tasks: Task[] = [];
      if (value.createTasks !== false) for (const draft of result.tasks) tasks.push(deps.createTask({ ...draft, projectId, provider: null, model: null, dependsOn: (draft.dependsOn ?? []).map((index) => tasks[index]!.id) }));
      state.plannerMessages.push({ id: newId('chat'), projectId, role: 'assistant', text: result.reply, createdAt: now(), taskIds: tasks.map((task) => task.id) }); ctx.changed();
      return { reply: result.reply, tasks };
    } catch (error) { if (!ctx.closing) { state.plannerMessages.push({ id: newId('chat'), projectId, role: 'system', text: (error as Error).message, createdAt: now() }); ctx.changed(); } throw error; }
    finally { this.planning.delete(projectId); this.planningAbort.delete(projectId); if (agent) this.planningAgents.delete(agent.id); if (!ctx.closing) ctx.changed(); }
  }
  async draft(projectId: string, input: unknown): Promise<Awaited<ReturnType<typeof draftTask>> | Awaited<ReturnType<typeof draftTasks>>> {
    const { ctx, deps } = this, state = ctx.state;
    this.assertEnabled();
    const project = ctx.project(projectId); const value = jsonObject(input);
    if (this.planning.has(projectId)) throw new ControlError('An AI request is already running for this project.', 409);
    const message = text(value.message, 'message', 30000).trim(); if (!message) throw new ControlError('Draft message is required.');
    const history = value.messages ?? [];
    if (!Array.isArray(history) || history.length > 40) throw new ControlError('Draft history may contain at most 40 messages.');
    const messages = history.map((raw) => { const item = jsonObject(raw); if (!['user', 'assistant'].includes(String(item.role))) throw new ControlError('Draft history role must be user or assistant.'); return { id: newId('draft'), projectId, role: item.role as 'user' | 'assistant', text: text(item.text, 'history text', 30000), createdAt: now() }; });
    messages.push({ id: newId('draft'), projectId, role: 'user', text: message, createdAt: now() });
    const settings = ctx.providerSettings(projectId);
    const agent = this.agent(value, settings.defaultProvider, 'Draft agent is disabled or busy.', 'Draft agent is disabled or busy.');
    const workspace = value.mode === 'workspace'; const requestId = value.requestId === undefined ? newId('draft') : text(value.requestId, 'requestId', 100);
    const choice = this.draftChoice(value);
    const currentDrafts = value.drafts ?? [];
    if (!Array.isArray(currentDrafts) || currentDrafts.length > 30) throw new ControlError('Draft workspace may contain at most 30 drafts.');
    const abort = new AbortController(); this.planning.add(projectId); this.planningAbort.set(projectId, abort); this.draftRequests.set(projectId, requestId); if (agent) this.planningAgents.add(agent.id);
    // Progress is transient: it is pushed to open clients and never written to the journal.
    const onOutput = lineReader((line) => { if (ctx.closing) return; const activity = planningActivity(line); if (activity) deps.emit('draft', { projectId, requestId, activity }); });
    try {
      const options = {
        agents: state.agents, workflows: state.workflows, existingTasks: state.tasks.filter((task) => task.projectId === projectId), skillsCatalog: state.skills, defaultProvider: settings.defaultProvider, defaultModels: settings.defaultModels,
        ...(value.draft === undefined ? {} : { currentDraft: jsonObject(value.draft) }), ...(workspace ? { currentDrafts: currentDrafts.map((draft) => jsonObject(draft)) } : {}), dataDir: ctx.store.directory, signal: abort.signal, onOutput,
        executionMode: state.settings.executionMode, image: state.settings.dockerImage, providerArgs: deps.launchProviderArgs(project.id), ...(choice ? { choice } : {}),
      };
      const skills = agent ? agent.skillIds.map((skillId) => deps.catalog.skill(skillId)) : [];
      const result = workspace ? await draftTasks(project, agent, skills, messages, options) : await draftTask(project, agent, skills, messages, options);
      if (ctx.closing) throw new ControlError('Service is stopping.', 503);
      return result;
    } finally { this.planning.delete(projectId); this.planningAbort.delete(projectId); this.draftRequests.delete(projectId); if (agent) this.planningAgents.delete(agent.id); if (!ctx.closing) ctx.changed(); }
  }
  /** Stops only the named draft request, so a late cancel never interrupts a newer planning turn. */
  cancelDraft(projectId: string, input: unknown): { cancelled: boolean } {
    this.ctx.project(projectId); const requestId = text(jsonObject(input).requestId, 'requestId', 100);
    if (this.draftRequests.get(projectId) !== requestId) return { cancelled: false };
    this.planningAbort.get(projectId)?.abort(); return { cancelled: true };
  }
  /**
   * Starts the task-queue organizer: an agent that runs in the project like a task agent, without a
   * board task, orders the backlog against the ready queue and moves actionable work to Ready via the CLI.
   */
  organize(projectId: string, input: unknown = {}): TaskOrganization {
    const { ctx, deps } = this;
    this.assertEnabled();
    const project = ctx.project(projectId); const value = jsonObject(input);
    // An optional milestoneId narrows the run to one milestone's tasks; 'none' selects the tasks without a milestone.
    const milestoneId = value.milestoneId === undefined || value.milestoneId === null || value.milestoneId === '' ? '' : text(value.milestoneId, 'milestoneId', 100);
    if (this.organizing.has(projectId)) throw new ControlError('Task organization is already running for this project.', 409);
    const tasks = ctx.state.tasks.filter((task) => task.projectId === projectId && !task.archivedAt
      && (!milestoneId || (milestoneId === 'none' ? !task.milestoneId : task.milestoneId === milestoneId)));
    if (!tasks.some((task) => task.status === 'backlog' && !task.externalDependency)) throw new ControlError('There are no backlog tasks to organize.', 409);
    const settings = ctx.providerSettings(project.id), provider = settings.defaultProvider; const requestId = newId('organize'); const abort = new AbortController();
    const organization: TaskOrganization = { requestId, status: 'running', provider, startedAt: now() };
    this.organizing.set(projectId, { requestId, abort }); this.organizations.set(projectId, organization);
    // Progress is transient like draft progress; only the start and the final report reach the journal.
    const onOutput = lineReader((line) => { if (ctx.closing) return; const activity = planningActivity(line); if (activity) deps.emit('organize', { projectId, requestId, activity }); });
    ctx.event(null, null, 'organize.started', `Task organizer started with ${provider} for ${tasks.filter((task) => task.status === 'backlog').length} backlog and ${tasks.filter((task) => task.status === 'ready').length} ready tasks.`, { projectId, requestId });
    ctx.changed();
    const { url, token } = deps.connection();
    ctx.background(organizeTasks(project, {
      tasks: structuredClone(tasks), defaultProvider: provider, defaultModels: settings.defaultModels, dataDir: ctx.store.directory, signal: abort.signal, onOutput,
      executionMode: ctx.state.settings.executionMode, image: ctx.state.settings.dockerImage, providerArgs: deps.launchProviderArgs(project.id),
      controlUrl: process.env.AIWS_CONTROL_AGENT_URL ?? url, ...(token ? { token } : {}),
    }).then((report) => {
      organization.status = 'completed'; organization.report = report;
      if (!ctx.closing) ctx.event(null, null, 'organize.completed', report || 'Task organizer finished.', { projectId, requestId });
    }, (error: Error) => {
      organization.status = abort.signal.aborted ? 'cancelled' : 'failed'; organization.error = error.message;
      if (!ctx.closing) ctx.event(null, null, `organize.${organization.status}`, error.message, { projectId, requestId });
    }).finally(() => {
      organization.finishedAt = now(); this.organizing.delete(projectId);
      if (!ctx.closing) ctx.changed();
    }));
    return structuredClone(organization);
  }
  /** Stops the running organizer; task changes it already made through the CLI stay in place. */
  cancelOrganize(projectId: string, input: unknown = {}): { cancelled: boolean } {
    this.ctx.project(projectId); const value = jsonObject(input); const current = this.organizing.get(projectId);
    if (!current || (value.requestId !== undefined && text(value.requestId, 'requestId', 100) !== current.requestId)) return { cancelled: false };
    current.abort.abort(); return { cancelled: true };
  }
  close(): void {
    for (const controller of this.planningAbort.values()) controller.abort();
    for (const { abort } of this.organizing.values()) abort.abort();
  }
  private assertEnabled(): void {
    if (!this.ctx.state.settings.systemEnabled) throw new ControlError('System is stopped. Enable the system to start new tasks.', 409);
  }
  /** The requested agent profile, else the first available one of the default provider; null plans without a profile. */
  private agent(value: Record<string, unknown>, defaultProvider: Provider, disabled: string, busy: string): AgentDefinition | null {
    const availability = agentAvailability(this.ctx.state, { handles: this.ctx.handles, planningAgents: this.planningAgents });
    const agent = typeof value.agentId === 'string' ? this.deps.catalog.agent(value.agentId) : this.ctx.state.agents.find((item) => availability[item.id]?.available && item.provider === defaultProvider) ?? null;
    if (agent && !agent.enabled) throw new ControlError(disabled, 409);
    if (agent && !availability[agent.id]?.available) throw new ControlError(busy, 409);
    return agent;
  }
  /** The provider, model and reasoning level chosen for one planning turn; undefined when the request names none. */
  private draftChoice(value: Record<string, unknown>): { provider?: Provider; model?: string; reasoningEffort?: string } | undefined {
    const provider = typeof value.provider === 'string' && value.provider ? value.provider : undefined;
    if (provider && (provider === 'command' || !aiProviders.get(provider))) throw new ControlError('Draft provider is not available.');
    const model = typeof value.model === 'string' && value.model.trim() ? text(value.model, 'model', 200).trim() : undefined;
    const effort = typeof value.reasoningEffort === 'string' && value.reasoningEffort ? value.reasoningEffort : undefined;
    if (effort && provider && !aiProviders.require(provider).reasoningEfforts.includes(effort)) throw new ControlError('Draft reasoning level is not supported by the provider.');
    return provider || model || effort ? { ...(provider ? { provider: provider as Provider } : {}), ...(model ? { model } : {}), ...(effort ? { reasoningEffort: effort } : {}) } : undefined;
  }
}
