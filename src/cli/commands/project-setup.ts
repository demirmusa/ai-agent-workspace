import type { AppContext } from './context.js';
import { loadTrackedRepository } from './repository-context.js';
import { loadInstallationCredentials } from '../../runtime/credential-store.js';
import { AiwsError } from '../../shared/core/logger.js';

interface SelectOption { id?: string; name: string; color: string; description: string }
export function addMissingStatuses(existing: SelectOption[], names: string[]): SelectOption[] {
  return [...existing, ...[...new Set(names)].filter((name) => !existing.some((option) => option.name === name))
    .map((name) => ({ name, color: 'GRAY', description: 'AIWS task lifecycle' }))];
}

export async function runProjectSetup(context: AppContext, options: { dryRun: boolean }): Promise<void> {
  const { config } = await loadTrackedRepository(context);
  const project = config.queue.project;
  if (!project) throw new AiwsError('Configure queue.project before setting up project states.');
  let token: string | undefined;
  try { token = (await loadInstallationCredentials(config.repository.slug)).projectToken; } catch { /* gh login may supply access. */ }
  const graphql = async (query: string, variables: object): Promise<any> => {
    const result = await context.runner.run('gh', ['api', 'graphql', '--input', '-'], {
      input: JSON.stringify({ query, variables }), ...(token ? { env: { GH_TOKEN: token }, redact: [token] } : {}),
    });
    const response = JSON.parse(result.stdout);
    if (response.errors?.length) throw new AiwsError(response.errors.map((error: { message: string }) => error.message).join('; '));
    return response.data;
  };
  const owner = project.ownerType;
  const fields: Array<{ id: string; name: string; options?: SelectOption[] }> = [];
  let after: string | null = null;
  let projectId = '';
  do {
    const data = await graphql(`query($owner:String!,$number:Int!,$after:String){${owner}(login:$owner){projectV2(number:$number){id fields(first:100,after:$after){nodes{... on ProjectV2SingleSelectField{id name options{id name color description}}} pageInfo{hasNextPage endCursor}}}}}`, { owner: project.owner, number: project.number, after });
    const value = data[owner]?.projectV2;
    if (!value) throw new AiwsError('Project not found or token cannot access it.');
    projectId = value.id;
    fields.push(...value.fields.nodes.filter((field: unknown) => field !== null));
    after = value.fields.pageInfo.hasNextPage ? value.fields.pageInfo.endCursor : null;
  } while (after);
  const field = fields.find(({ name }) => name === project.statusField);
  const names = [project.organization, project.ready, project.inProgress, project.inReview, project.done];
  const optionsWithIds = addMissingStatuses(field?.options ?? [], names);
  const missing = optionsWithIds.filter(({ id }) => !id);
  if (missing.length === 0) { context.logger.success('All configured project states already exist.'); return; }
  context.logger.info(`Project states to add: ${missing.map(({ name }) => name).join(', ')}`);
  if (options.dryRun) return;
  if (field) {
    // Preserve option IDs, colors and descriptions so existing cards keep their state.
    await graphql('mutation($input:UpdateProjectV2FieldInput!){updateProjectV2Field(input:$input){projectV2Field{... on ProjectV2SingleSelectField{id}}}}',
      { input: { fieldId: field.id, singleSelectOptions: optionsWithIds } });
  } else {
    await graphql('mutation($input:CreateProjectV2FieldInput!){createProjectV2Field(input:$input){projectV2Field{... on ProjectV2SingleSelectField{id}}}}',
      { input: { projectId, name: project.statusField, dataType: 'SINGLE_SELECT', singleSelectOptions: optionsWithIds } });
  }
  context.logger.success('Project states are ready, including Organization. Existing state identities were preserved.');
}
