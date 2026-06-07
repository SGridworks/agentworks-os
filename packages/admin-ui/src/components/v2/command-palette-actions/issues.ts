import { ActionRegistryItem } from '../command-palette';

// Create issue actions for command palette
export function createIssueActions(): ActionRegistryItem[] {
  const actions: ActionRegistryItem[] = [
    {
      id: 'issue.create',
      verb: 'Create',
      noun: 'Issue',
      description: 'Create a new issue',
      icon: '📝',
      scope: 'global',
      handler: 'issue.create',
      keywords: ['create', 'issue', 'new', 'ticket', 'task'],
    },
  ];

  return actions;
}

// Create issue assignment actions for command palette
export function createIssueAssignActions(issues: Array<{id: string; title: string; identifier?: string | null}>): ActionRegistryItem[] {
  const actions: ActionRegistryItem[] = [];

  // Add assign actions for each issue
  issues.forEach(issue => {
    const displayTitle = issue.identifier ? `${issue.identifier} · ${issue.title}` : issue.title;
    actions.push({
      id: `issue.assign-${issue.id}`,
      verb: 'Assign',
      noun: displayTitle,
      description: `Assign issue to an agent`,
      icon: '👤',
      scope: 'global',
      handler: 'issue.assign',
      keywords: ['assign', 'issue', issue.title.toLowerCase(), issue.identifier?.toLowerCase() || ''],
    });
  });

  return actions;
}

