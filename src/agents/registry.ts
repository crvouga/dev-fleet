import { AgentConfigurationError } from './errors';
import source from '../../agents/registry.json';
import { createHash } from 'node:crypto';
import { fleet } from '../fleet-config';

export type Tool = keyof typeof source.defaults;
export type Profile = 'direct' | 'proxy';
export type Selection = {
  node: string;
  tool: Tool;
  profile: Profile;
  model: string;
};
/** The tracked registry plus the proxy endpoint from this fleet's config. */
export const registry = {
  ...source,
  proxy: { endpoint: fleet.services.proxy.endpoint, ...source.proxy },
};

export function select(node: string, tool: string, profile: string): Selection {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(node))
    throw new AgentConfigurationError('Invalid node ID.');
  if (!(tool in source.defaults) || !['direct', 'proxy'].includes(profile))
    throw new AgentConfigurationError(
      'Unsupported tool/profile; run bun src/agents/cli.ts agents inventory.'
    );
  const id = tool as Tool;
  const model = resolveModel(node, id, profile as Profile);
  if (!model || !/^[a-zA-Z0-9_./:+-]+$/.test(model))
    throw new AgentConfigurationError(
      'No approved model. Add an exact model ID to agents/registry.json and review it.'
    );
  return { node, tool: id, profile: profile as Profile, model };
}

export function resolveModel(
  node: string,
  tool: Tool,
  profile: Profile,
  nodes = source.nodes as Record<
    string,
    Partial<Record<Tool, { direct?: string; proxy?: string }>>
  >
) {
  const override = nodes[node]?.[tool]?.[profile];
  const models = source.proxy.models as Partial<Record<Tool, string | null>>;
  return (
    override ??
    (profile === 'direct' ? source.defaults[tool].model : models[tool])
  );
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
