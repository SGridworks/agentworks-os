import { describe, it, expect } from 'vitest';
import { createIssueActions, createIssueAssignActions } from './issues';

describe('Issue Command Palette Actions', () => {
  it('should create basic issue actions', () => {
    const actions = createIssueActions();

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      id: 'issue.create',
      verb: 'Create',
      noun: 'Issue',
      description: 'Create a new issue',
      icon: '📝',
      scope: 'global',
      handler: 'issue.create',
      keywords: ['create', 'issue', 'new', 'ticket', 'task'],
    });
  });

  it('should create issue assignment actions', () => {
    const mockIssues = [
      { id: 'issue-1', title: 'Test Issue', identifier: 'TEST-1' },
      { id: 'issue-2', title: 'Another Issue', identifier: null },
    ];

    const actions = createIssueAssignActions(mockIssues);

    expect(actions).toHaveLength(2);

    // Check first action with identifier
    expect(actions[0]).toMatchObject({
      id: 'issue.assign-issue-1',
      verb: 'Assign',
      icon: '👤',
      scope: 'global',
      handler: 'issue.assign',
    });
    expect(actions[0].noun).toBe('TEST-1 · Test Issue');

    // Check second action without identifier
    expect(actions[1]).toMatchObject({
      id: 'issue.assign-issue-2',
      verb: 'Assign',
      icon: '👤',
      scope: 'global',
      handler: 'issue.assign',
    });
    expect(actions[1].noun).toBe('Another Issue');
  });

  it('should include correct keywords', () => {
    const mockIssues = [
      { id: 'issue-1', title: 'Test Issue', identifier: 'TEST-1' },
    ];

    const actions = createIssueAssignActions(mockIssues);

    expect(actions[0].keywords).toContain('assign');
    expect(actions[0].keywords).toContain('issue');
    expect(actions[0].keywords).toContain('test issue');
    expect(actions[0].keywords).toContain('test-1');
  });
});
