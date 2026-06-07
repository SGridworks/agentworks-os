import type { ActionRegistryItem } from '../command-palette';

export interface CommandPaletteAgent {
  id: string;
  name: string;
  title?: string | null;
  role?: string | null;
}

export function createAgentActions(agents: CommandPaletteAgent[]): ActionRegistryItem[] {
  return agents.flatMap((agent) => {
    const label = agent.name;
    const role = agent.role ?? '';
    const title = agent.title ?? agent.name;
    const keywords = [label.toLowerCase()];
    if (role) keywords.push(role.toLowerCase());

    return [
      {
        id: `agent.wake-${agent.id}`,
        verb: 'Wake',
        noun: label,
        description: `Activate agent ${title}`,
        icon: '⚡',
        scope: 'global',
        handler: 'agent.wake',
        keywords: ['wake', ...keywords],
      },
      {
        id: `agent.pause-${agent.id}`,
        verb: 'Pause',
        noun: label,
        description: `Pause agent ${title}`,
        icon: '⏸️',
        scope: 'global',
        handler: 'agent.pause',
        dangerous: false,
        keywords: ['pause', ...keywords],
      },
    ];
  });
}
