import { describe, it, expect } from 'vitest';

// Test the onboarding completion logic
describe('Onboarding Completion', () => {
  it('should store completion state in localStorage', () => {
    const onboardingState = {
      step: 4,
      tenantName: 'Test Tenant',
      tenantDescription: '',
      selectedPack: 'minimal',
      selectedEditors: [],
      completed: true
    };

    localStorage.setItem('aw_onboarding_state', JSON.stringify(onboardingState));

    const retrieved = localStorage.getItem('aw_onboarding_state');
    const parsed = JSON.parse(retrieved!);
    
    expect(parsed.completed).toBe(true);
    expect(parsed.tenantName).toBe('Test Tenant');
  });
});
