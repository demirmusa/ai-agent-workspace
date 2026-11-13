import { select } from '@inquirer/prompts';
import { AiwsError } from '../../shared/core/logger.js';
import { AGENT_PROVIDERS } from '../../shared/config/schema.js';
import type { AppContext } from './context.js';
import { runConfigure } from './configure.js';
import { runDoctor } from './doctor.js';
import { runLogin } from './login.js';
import { runStatus } from './status.js';
import { runUp } from './up.js';
import { runQueueStatus } from './queue.js';
import { runTargetSettings } from './target-settings.js';

export async function runMenu(context: AppContext): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new AiwsError('The menu requires an interactive terminal.', 2, 'Use aiws --help for scriptable commands.');
  for (;;) {
    const action = await select({ message: 'AIWS control center', choices: [
      { name: 'Settings — agents, models, concurrency, organization, review, labels and more', value: 'settings' },
      { name: 'Status — containers, authentication and recent runs', value: 'status' },
      { name: 'Queue — running, waiting, failed and ready tasks', value: 'queue' },
      { name: 'Docker host — local / SSH connection settings', value: 'target' },
      { name: 'Login — GitHub / Claude / Codex / OpenCode', value: 'login' },
      { name: 'Start / update Docker runtime', value: 'up' },
      { name: 'Doctor — check prerequisites', value: 'doctor' },
      { name: 'Exit', value: 'exit' },
    ] });
    if (action === 'exit') return;
    try {
      if (action === 'settings') await runConfigure(context);
      if (action === 'status') await runStatus(context, { json: false });
      if (action === 'queue') await runQueueStatus(context, { json: false });
      if (action === 'target') await runTargetSettings(context, {});
      if (action === 'doctor') await runDoctor(context, { json: false });
      if (action === 'up') await runUp(context, { pull: false, dryRun: false });
      if (action === 'login') {
        const provider = await select({ message: 'Authenticate', choices: ['all', 'github', ...AGENT_PROVIDERS].map((value) => ({ name: value, value })) });
        const auth = provider === 'codex' || provider === 'claude' ? await select({ message: `${provider} login method`, choices: [
          { name: 'Subscription / device login', value: 'subscription' as const },
          { name: 'API key (hidden input or environment variable)', value: 'api-key' as const },
        ] }) : 'subscription';
        await runLogin(context, { provider, auth });
      }
    } catch (error) { context.logger.error(error instanceof Error ? error.message : String(error)); }
  }
}
