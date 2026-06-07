import { describe, it, expect } from 'vitest';
import { createAgentActions } from './agents';

describe('createAgentActions', () => {
  it('creates wake and pause actions for each agent', () => {
    const mockAgents = [
      {
        id: 'agent-1',
        name: 'Test Agent 1',
        title: 'Test Title 1',
        role: 'tester'
      },
      {
        id: 'agent-2', 
        name: 'Test Agent 2',
        title: null,
        role: 'developer'
      }
    ];

    const actions = createAgentActions(mockAgents);

    // Should have 4 actions total (2 agents × 2 actions each)
    expect(actions).toHaveLength(4);

    // Check wake actions
    const wakeActions = actions.filter(action => action.verb === 'Wake');
    expect(wakeActions).toHaveLength(2);
    
    const wakeAgent1 = wakeActions.find(action => action.noun === 'Test Agent 1');
    expect(wakeAgent1).toBeDefined();
    expect(wakeAgent1?.id).toBe('agent.wake-agent-1');
    expect(wakeAgent1?.handler).toBe('agent.wake');
    expect(wakeAgent1?.icon).toBe('⚡');
    expect(wakeAgent1?.scope).toBe('global');
    expect(wakeAgent1?.keywords).toContain('wake');
    expect(wakeAgent1?.keywords).toContain('test agent 1');
    expect(wakeAgent1?.keywords).toContain('tester');

    const wakeAgent2 = wakeActions.find(action => action.noun === 'Test Agent 2');
    expect(wakeAgent2).toBeDefined();
    expect(wakeAgent2?.id).toBe('agent.wake-agent-2');
    expect(wakeAgent2?.description).toBe('Activate agent Test Agent 2'); // Uses name when title is null

    // Check pause actions
    const pauseActions = actions.filter(action => action.verb === 'Pause');
    expect(pauseActions).toHaveLength(2);
    
    const pauseAgent1 = pauseActions.find(action => action.noun === 'Test Agent 1');
    expect(pauseAgent1).toBeDefined();
    expect(pauseAgent1?.id).toBe('agent.pause-agent-1');
    expect(pauseAgent1?.handler).toBe('agent.pause');
    expect(pauseAgent1?.icon).toBe('⏸️');
    expect(pauseAgent1?.dangerous).toBe(false);
    expect(pauseAgent1?.keywords).toContain('pause');
    expect(pauseAgent1?.keywords).toContain('test agent 1');
  });

  it('handles empty agents array', () => {
    const actions = createAgentActions([]);
    expect(actions).toHaveLength(0);
  });

  it('handles agents without optional fields', () => {
    const mockAgents = [
      {
        id: 'agent-1',
        name: 'Minimal Agent'
        // title and role are undefined
      }
    ];

    const actions = createAgentActions(mockAgents as any);
    expect(actions).toHaveLength(2);

    const wakeAction = actions.find(action => action.verb === 'Wake');
    expect(wakeAction?.description).toBe('Activate agent Minimal Agent');
    expect(wakeAction?.keywords).toContain('minimal agent');
  });
});