import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ActionDetailsPopover } from './ActionDetailsPopover';
import { AutopilotAction } from '@/lib/api';

// Mock action with comprehensive data
const mockAction: AutopilotAction = {
  id: 'test-action-1',
  actionId: 'action-123',
  actorId: 'actor-456',
  actorType: 'agent',
  actorLabel: 'Test Agent',
  tenantId: 'tenant-789',
  proposedActionKind: 'create_issue',
  proposedActionSummary: 'Create issue for customer support',
  decision: 'needsApproval',
  riskScore: 0.65,
  reasons: [
    'Action involves customer data access',
    'High impact on customer experience',
    'Requires human review for compliance'
  ],
  proposedAt: '2024-01-15T10:30:00Z',
  decidedAt: '2024-01-15T10:31:00Z'
};

const mockActionNoReasons: AutopilotAction = {
  ...mockAction,
  id: 'test-action-2',
  reasons: [],
  decision: 'allow',
  riskScore: 0.25
};

describe('ActionDetailsPopover', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <ActionDetailsPopover 
        popover={{ isOpen: false, action: null, position: { top: 0, left: 0 } }}
        onClose={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders popover when open with action', () => {
    render(
      <ActionDetailsPopover 
        popover={{ isOpen: true, action: mockAction, position: { top: 100, left: 200 } }}
        onClose={vi.fn()}
      />
    );

    // Check header
    expect(screen.getByText('Action Details')).toBeInTheDocument();
    
    // Check action summary
    expect(screen.getByText('Create issue for customer support')).toBeInTheDocument();
    
    // Check risk assessment
    expect(screen.getByText('Risk Assessment')).toBeInTheDocument();
    expect(screen.getByText('0.65')).toBeInTheDocument();
    expect(screen.getByText('Needs Approval')).toBeInTheDocument();
    
    // Check bucketing reasons
    expect(screen.getByText('Bucketing Reasons')).toBeInTheDocument();
    expect(screen.getByText('Action involves customer data access')).toBeInTheDocument();
  });

  it('renders empty state when no reasons provided', () => {
    render(
      <ActionDetailsPopover 
        popover={{ isOpen: true, action: mockActionNoReasons, position: { top: 100, left: 200 } }}
        onClose={vi.fn()}
      />
    );

    // Should still show action details
    expect(screen.getByText('Create issue for customer support')).toBeInTheDocument();
    expect(screen.getByText('Safe')).toBeInTheDocument();
    expect(screen.getByText('0.25')).toBeInTheDocument();
    
    // Should not show bucketing reasons section
    expect(screen.queryByTestId('bucketing-reasons')).not.toBeInTheDocument();
  });







  it('applies correct color coding for different risk levels', () => {
    const { rerender } = render(
      <ActionDetailsPopover 
        popover={{ isOpen: true, action: { ...mockAction, riskScore: 0.2, decision: 'allow' }, position: { top: 100, left: 200 } }}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('0.20')).toBeInTheDocument();
    expect(screen.getByText('Safe')).toBeInTheDocument();

    // Test medium risk
    rerender(
      <ActionDetailsPopover 
        popover={{ isOpen: true, action: { ...mockAction, riskScore: 0.5, decision: 'needsApproval' }, position: { top: 100, left: 200 } }}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('0.50')).toBeInTheDocument();
    expect(screen.getByText('Needs Approval')).toBeInTheDocument();

    // Test high risk
    rerender(
      <ActionDetailsPopover 
        popover={{ isOpen: true, action: { ...mockAction, riskScore: 0.8, decision: 'risky' }, position: { top: 100, left: 200 } }}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('0.80')).toBeInTheDocument();
    expect(screen.getByText('Risky')).toBeInTheDocument();
  });

  it('renders all policy decision details correctly', () => {
    render(
      <ActionDetailsPopover 
        popover={{ isOpen: true, action: mockAction, position: { top: 100, left: 200 } }}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('Actor Type:')).toBeInTheDocument();
    expect(screen.getByText('agent')).toBeInTheDocument();
    expect(screen.getByText('Tenant ID:')).toBeInTheDocument();
    expect(screen.getByText('tenant-789')).toBeInTheDocument();
  });
});