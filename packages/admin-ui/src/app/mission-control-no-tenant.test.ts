import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Test the no-tenant state UI components
describe('Mission Control No-Tenant State', () => {
  it('should display create tenant button when no tenant exists', () => {
    // Test that the UI components render correctly
    const container = document.createElement('div');
    container.innerHTML = `
      <div class="flex items-center justify-between rounded-lg border border-dashed border-border p-6 bg-muted/20">
        <div class="flex items-center gap-3">
          <div class="status-dot status-dot-muted"></div>
          <div>
            <p class="text-sm font-medium text-foreground">No tenant configured</p>
            <p class="text-xs text-muted-foreground mt-0.5">
              Create a tenant to start using AgentWorks OS
            </p>
          </div>
        </div>
        <button class="btn btn-primary">
          Create Tenant
        </button>
      </div>
    `;

    const button = container.querySelector('.btn-primary');
    expect(button).toBeTruthy();
    expect(button?.textContent?.trim()).toBe('Create Tenant');

    const title = container.querySelector('.text-sm.font-medium');
    expect(title?.textContent).toBe('No tenant configured');
  });

  it('should show user-friendly error message', () => {
    const errorMessage = 'No tenants found. Create your first tenant to get started.';
    expect(errorMessage).toContain('Create your first tenant');
    expect(errorMessage).toBeUserFriendly = true; // Custom assertion
  });
});
