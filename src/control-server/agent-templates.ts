import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findAssetsRoot } from '../shared/core/assets.js';
import type { AgentTemplateCatalog } from './types.js';

// Local bundled data only: opening the library never contacts GitHub or mutates
// profile state. Explicitly saved copies remain independent of future updates.
const catalogs = new Map<string, Promise<AgentTemplateCatalog>>();
export async function listAgentTemplates(): Promise<AgentTemplateCatalog> {
  const directory = await findAssetsRoot();
  let pending = catalogs.get(directory);
  if (!pending) {
    pending = readFile(join(directory, 'agent-templates', 'catalog.json'), 'utf8').then((source) => {
      const catalog = JSON.parse(source) as AgentTemplateCatalog;
      if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.items) || !catalog.items.length || catalog.items.length > 500 || new Set(catalog.items.map((item) => item.id)).size !== catalog.items.length) throw new Error('Invalid bundled agent template catalog.');
      return catalog;
    }).catch((error: unknown) => { catalogs.delete(directory); throw error; });
    catalogs.set(directory, pending);
  }
  return structuredClone(await pending);
}
