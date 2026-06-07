import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AutopilotPage from './page';

describe('AutopilotPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the current autopilot buckets and bulk controls', () => {
    render(<AutopilotPage />);

    expect(screen.getByRole('button', { name: 'Dispatch all safe' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve all needs-approval' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acknowledge risky' })).toBeInTheDocument();
    expect(screen.getByText('Safe')).toBeInTheDocument();
    expect(screen.getByText('Needs Approval')).toBeInTheDocument();
    expect(screen.getByText('Risky')).toBeInTheDocument();
  });

  it('renders sample actions in the expected buckets', () => {
    render(<AutopilotPage />);

    expect(screen.getByRole('button', { name: 'Dispatch items for safe bucket' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Items pending approval' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'High-risk items' })).toBeInTheDocument();
  });

  it('opens the action details popover for an action', () => {
    render(<AutopilotPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Items pending approval' }));

    expect(screen.getByText('Action Details')).toBeInTheDocument();
    expect(screen.getAllByText('Items pending approval')).toHaveLength(2);
    expect(screen.getAllByText('Needs Approval').length).toBeGreaterThan(0);
  });
});
