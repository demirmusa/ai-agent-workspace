'use strict';
// Lookups derived from the state: projects, tasks, runs, providers and agents.
// The general workspace opens like a project, but is listed under Agents instead of among the projects.
const project = () => state.projects.find(item => item.id === projectId) || (projectId && state.generalWorkspace?.id === projectId ? state.generalWorkspace : undefined);
const isGeneralProject = id => Boolean(id) && state.generalWorkspace?.id === id;
const projectName = item => item?.general ? globalThis.AIWSI18n.text(item.name) : item?.name || '';
const task = () => state.tasks.find(item => item.id === selectedTaskId);
/** The project or general workspace a task belongs to. */
const taskProject = item => state.projects.find(value => value.id === item?.projectId) || (isGeneralProject(item?.projectId) ? state.generalWorkspace : undefined);
// Derived lookups are rebuilt once per received state instead of once per card.
let stateVersion=0,journalVersion=0;
const derivedCache=new Map();
function derived(key,version,compute){const entry=derivedCache.get(key);if(entry&&entry.version===version)return entry.value;const value=compute();derivedCache.set(key,{version,value});return value;}
function groupByTask(items){const groups=new Map();for(const item of items){if(!item.taskId)continue;let list=groups.get(item.taskId);if(!list)groups.set(item.taskId,list=[]);list.push(item);}return groups;}
const taskEvents=taskId=>derived('events',journalVersion,()=>groupByTask(state.events)).get(taskId)||[];
const taskMessages=taskId=>derived('messages',journalVersion,()=>groupByTask(state.messages||[])).get(taskId)||[];
const runById=runId=>derived('runs',stateVersion,()=>new Map(state.runs.map(run=>[run.id,run]))).get(runId);
const taskRuns=taskId=>derived('taskRuns',stateVersion,()=>groupByTask(state.runs)).get(taskId)||[];
/** Pending questions and approvals of active runs, in state order. */
const activeInputRequests=()=>derived('requests',stateVersion,()=>state.questions.filter(item=>item.status==='pending'&&activeRun(runById(item.runId))));
const pending = taskId => derived('pending',stateVersion,()=>groupByTask(activeInputRequests())).get(taskId)||[];
const taskAgent = item => state.agents.find(agent=>agent.id===item.agentId);
// The agent a run executed as, or its provider when it ran without one.
const runAgentName = run => run.executionSnapshot?.agent?.name||providers[run.provider]||run.provider;
const projectProviderSettings=(item=project())=>state.resolvedProviderSettings?.[item?.id]||state.settings;
const defaultProvider = () => projectProviderSettings().defaultProvider || 'codex';
// The latest agent run of each task (command runs excluded).
const taskLastRun = item => derived('lastRun',stateVersion,()=>{const latest=new Map();for(const run of state.runs){if(run.provider==='command'||!run.taskId)continue;const current=latest.get(run.taskId);if(!current||Date.parse(run.startedAt)>Date.parse(current.startedAt))latest.set(run.taskId,run);}return latest;}).get(item.id);
const taskProvider = item => item.providerOverride || taskAgent(item)?.provider || (!item.agentId&&taskLastRun(item)?.provider) || item.provider || defaultProvider();
const taskAgentLabel = item => {const agent=taskAgent(item);if(agent)return agent.name;const custom=item.providerOverride||item.modelOverride,run=custom?null:taskLastRun(item),provider=item.providerOverride||run?.provider,model=item.modelOverride||run?.executionInfo?.model;return model||(provider&&providers[provider])||'';};
const taskModel = item => item.modelOverride || taskAgent(item)?.model || item.model;
// Cards name the model next to the agent: the running run's reported model first, then the configured one.
const taskCardLabel = (item,run) => {const label=taskAgentLabel(item)||globalThis.AIWSI18n.text('Otomatik agent'),last=run||taskLastRun(item),model=item.modelOverride||(last?.provider===taskProvider(item)?last.executionInfo?.model:'')||taskModel(item);return model&&!label.includes(model)?`${label} · ${model}`:label;};
// Session continuations started from history belong to the sessions tab, not the board.
const tasks = () => state.tasks.filter(item => !item.sessionContinuation&&(activeScreen==='overview'||item.projectId === projectId));
/** Search text folded the same way on both sides: Turkish lower case, with dotted and dotless i treated alike (AIWS matches aiws). */
const searchFold = text => String(text).toLocaleLowerCase('tr').replace(/ı/g,'i');
// The search matches the title, description, task key (AIWS-AB12CD or #42) and label names; task tags hold the label names.
const taskMatchesQuery = (item,needle=searchFold(query)) => !needle||searchFold(`${item.title} ${item.description} ${taskKey(item)} ${item.github?.issueNumber||''} ${(item.tags||[]).join(' ')}`).includes(needle);
// Tasks waiting for their scheduled start live on the schedules tab, not the board.
const boardTasks = () => tasks().filter(item => item.archivedAt||!scheduledWaiting(item));
/** The project board's milestone filter: '' shows every task, 'none' the tasks without a milestone. It applies to one project's board only. */
const taskMatchesMilestone=item=>!milestoneFilter||activeScreen!=='board'||(milestoneFilter==='none'?!item.milestoneId:item.milestoneId===milestoneFilter);
/** The board tasks the toolbar shows: the archive or the open tasks, narrowed by the search, the agent and the milestone filter. */
function filteredBoardTasks(){const needle=searchFold(query);return boardTasks().filter(item=>Boolean(item.archivedAt)===archiveView&&taskMatchesQuery(item,needle)&&(!providerFilter||taskProvider(item)===providerFilter)&&taskMatchesMilestone(item));}
// Whether a project has running terminals or agent runs; the projects with running agents are found once per state.
function projectTerminalsRunning(id){return Boolean(projectShells.get(id)?.items.some(run=>run.status==='running'));}
const projectsWithRunningAgents=()=>derived('runningProjects',stateVersion,()=>{const owner=new Map(state.tasks.map(task=>[task.id,task.projectId]));return new Set(state.runs.filter(run=>run.status==='running').map(run=>owner.get(run.taskId)).filter(Boolean));});
