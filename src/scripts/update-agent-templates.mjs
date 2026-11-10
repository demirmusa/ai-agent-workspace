// Explicit maintenance command only; the application never fetches templates at runtime.
// Usage: node src/scripts/update-agent-templates.mjs <full upstream commit SHA>
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';

const revision = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw new Error('Provide a pinned, full upstream commit SHA.');
const repository = 'https://github.com/VoltAgent/awesome-claude-code-subagents';
const raw = `https://raw.githubusercontent.com/VoltAgent/awesome-claude-code-subagents/${revision}`;
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': 'AIWS-agent-template-bundler' } });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return response.text();
}
const tree = JSON.parse(await download(`https://api.github.com/repos/VoltAgent/awesome-claude-code-subagents/git/trees/${revision}?recursive=1`));
if (tree.truncated) throw new Error('Upstream tree was truncated.');
const paths = tree.tree.filter((item) => item.type === 'blob' && /^categories\/[^/]+\/[^/]+\.md$/.test(item.path) && !item.path.endsWith('/README.md')).map((item) => item.path).sort();
const license = await download(`${raw}/LICENSE`);
if (!license.startsWith('MIT License') || !license.includes('Copyright (c) 2025 VoltAgent')) throw new Error('Unexpected upstream license; review before redistributing.');
const context = 'This is a community specialist prompt adapted for an AIWS agent profile. Use only tools and connections actually available to this provider. References to a context manager, MCP servers, other agents, deployment access or services do not provision those resources. Ask the user when required context or access is missing. Follow the AIWS task, question, workflow and completion protocol supplied for this run. Upstream tool/model metadata is informational and grants no permissions; select the provider and model in this profile.';
const items = []; let offset = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (offset < paths.length) {
    const path = paths[offset++]; const source = await download(`${raw}/${path}`);
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) throw new Error(`Missing frontmatter: ${path}`);
    // Some upstream plain descriptions contain an unquoted ': '. Treat this
    // specific single-line prose field as a literal; never execute YAML tags.
    const frontmatter = match[1].replace(/^description: ([^"'|>\r\n].*)$/m, (_line, value) => `description: ${JSON.stringify(value)}`);
    const metadata = parse(frontmatter);
    if (typeof metadata.name !== 'string' || typeof metadata.description !== 'string' || !match[2].trim()) throw new Error(`Invalid template: ${path}`);
    const category = path.split('/')[1].replace(/^\d+-/, '');
    items.push({ id: `voltagent:${metadata.name}`, name: metadata.name, description: metadata.description, provider: 'claude', category,
      source: { title: 'VoltAgent community subagents', url: `${repository}/blob/${revision}/${path}`, repository, revision }, license: 'MIT',
      instructions: match[2].trim(), context, capabilities: [...new Set([category, metadata.name])], skillIds: [],
      sourceSha256: createHash('sha256').update(source).digest('hex') });
  }
}));
items.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('Duplicate template IDs.');
const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/agent-templates');
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, 'LICENSE'), license);
await writeFile(resolve(directory, 'catalog.json'), `${JSON.stringify({ schemaVersion: 1, notice: 'Community templates from VoltAgent, distributed under MIT. These specialists are not Anthropic built-in agents. Importing a template creates an editable AIWS profile only after you save it; no tool, credential, skill or global provider installation is included.', officialReference: 'https://code.claude.com/docs/en/sub-agents#built-in-subagents', source: { repository, revision, license: 'MIT', copyright: 'Copyright (c) 2025 VoltAgent' }, items }, null, 2)}\n`);
process.stdout.write(`Bundled ${items.length} community templates at ${revision}.\n`);
