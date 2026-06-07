export interface EffectiveModelInfo {
  model: string;
  source: 'ISSUE_METADATA' | 'AGENT_CONFIG' | 'DEFAULT';
}

export function resolveEffectiveModel(issue: any, agent: any): EffectiveModelInfo {
  // Priority 1: issue metadata model (highest)
  if (issue?.metadata?.model) {
    return { model: issue.metadata.model, source: 'ISSUE_METADATA' };
  }

  // Priority 2: agent config model
  if (agent?.model) {
    return { model: agent.model, source: 'AGENT_CONFIG' };
  }

  // Priority 3: default model (lowest)
  return { model: 'nemotron-3-nano:30b', source: 'DEFAULT' };
}