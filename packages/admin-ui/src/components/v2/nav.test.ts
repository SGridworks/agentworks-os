import { describe, it, expect } from 'vitest';
import { NAV_TO_PATH, type NavKey } from './nav';

describe('Navigation configuration', () => {
  it('should include autopilot in navigation paths', () => {
    expect(NAV_TO_PATH).toHaveProperty('autopilot');
    expect(NAV_TO_PATH.autopilot).toBe('/autopilot');
    expect(NAV_TO_PATH).toHaveProperty('automations');
    expect(NAV_TO_PATH.automations).toBe('/automations');
    expect(NAV_TO_PATH).toHaveProperty('issues');
    expect(NAV_TO_PATH.issues).toBe('/issues');
    expect(NAV_TO_PATH).toHaveProperty('review-queue');
    expect(NAV_TO_PATH['review-queue']).toBe('/review-queue');
  });

  it('should include autopilot in NavKey type', () => {
    // This test verifies that the type system accepts 'autopilot' as a valid NavKey
    const testNavKey: NavKey = 'autopilot';
    const automationNavKey: NavKey = 'automations';
    const issuesNavKey: NavKey = 'issues';
    const reviewQueueNavKey: NavKey = 'review-queue';
    expect(testNavKey).toBe('autopilot');
    expect(automationNavKey).toBe('automations');
    expect(issuesNavKey).toBe('issues');
    expect(reviewQueueNavKey).toBe('review-queue');
  });
});
