import type { RepoConfig } from '../../shared/config/schema.js';
import type { LabelDefinition } from '../../shared/github/client.js';

/** Every GitHub label the runner workflows and scheduler rely on, deduplicated case-insensitively. */
export function labelsForConfig(config: RepoConfig): LabelDefinition[] {
  const labels: LabelDefinition[] = [
    { name: config.queue.labels.run, color: '0E8A16', description: 'Run this task with an available agent' },
    { name: config.queue.labels.organize, color: 'C5DEF5', description: 'Organize issue dependencies before execution' },
    { name: config.queue.labels.waiting, color: 'D4C5F9', description: 'Waiting for dependency tasks' },
    { name: config.queue.labels.ready, color: '0E8A16', description: 'Queue this issue for AIWS' },
    { name: config.queue.labels.running, color: 'FBCA04', description: 'AIWS is working on this issue' },
    { name: config.queue.labels.done, color: '1D76DB', description: 'AIWS opened or updated a pull request' },
    { name: config.queue.labels.failed, color: 'B60205', description: 'The AIWS run needs attention' },
    { name: config.queue.labels.continue, color: 'FEF2C0', description: 'Resume the existing AIWS branch' },
    ...config.agents.profiles.map((profile) => ({
      name: profile.triggerLabel,
      color: profile.provider === 'codex' ? '0A7B83' : '9A67EA',
      description: `Use the ${profile.id} agent profile`,
    })),
    ...config.hooks.custom.flatMap((hook) =>
      hook.label
        ? [{ name: hook.label, color: '5319E7', description: `Run the ${hook.id} AIWS hook` }]
        : [],
    ),
  ];
  return [...new Map(labels.map((label) => [label.name.toLowerCase(), label])).values()];
}
