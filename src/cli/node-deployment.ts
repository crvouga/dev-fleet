import { join } from 'node:path';
import { read, object, write } from '../t3/files';
import { FleetUsageError } from '../errors';

export async function deployment(root: string) {
  const raw = await read(join(root, 'node_modules/.personal-node.json'));
  if (raw === null) return null;
  const data = object(raw);
  if (
    data['version'] !== 1 ||
    typeof data['revision'] !== 'string' ||
    !/^[a-f0-9]{40}$/.test(data['revision']) ||
    typeof data['node'] !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(data['node'])
  )
    throw new FleetUsageError(
      'Invalid local node receipt. Restore it before reconciling.'
    );
  return {
    workspace: join(root, 'node_modules/.fleet-revisions', data['revision']),
    node: data['node'],
    revision: data['revision'],
  };
}

export async function recordDeployment(
  root: string,
  node: string,
  revision: string
) {
  const path = join(root, 'node_modules/.personal-node.json');
  const content = JSON.stringify({ version: 1, node, revision }) + '\n';
  if ((await read(path)) !== content) await write(path, content);
}
