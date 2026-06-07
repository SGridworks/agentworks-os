'use client';

import { Info, X } from 'lucide-react';

interface ActionDetailsPopoverProps {
  popover: {
    isOpen: boolean;
    action: any;
    position: { top: number; left: number };
  };
  onClose: () => void;
}

export function ActionDetailsPopover({ popover, onClose }: ActionDetailsPopoverProps) {
  if (!popover.isOpen || !popover.action) return null;

  const { action, position } = popover;
  const decision = action.autopilotDecision ?? action.decision;
  const decisionLabel =
    decision === 'allow' ? 'Safe' :
    decision === 'needsApproval' ? 'Needs Approval' :
    decision === 'risky' ? 'Risky' : 'Unknown';
  const timestamp = action.createdAt ?? action.proposedAt ?? action.updatedAt ?? action.decidedAt;

  return (
    <>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          zIndex: 40,
        }}
        onClick={onClose}
        role="button"
        aria-label="Close popover"
      />
      <div
        style={{
          position: 'fixed',
          top: position.top,
          left: position.left,
          width: '380px',
          maxHeight: '400px',
          backgroundColor: 'var(--bg-card)',
          border: '1px solid var(--rule)',
          borderRadius: '8px',
          boxShadow: 'var(--shadow-2)',
          zIndex: 50,
          overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: '1px solid var(--rule)',
          backgroundColor: 'var(--bg-2)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Info size={16} style={{ color: 'var(--accent)' }} />
            <h3 style={{ fontSize: '14px', fontWeight: 500, margin: 0 }}>
              Action Details
            </h3>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--ink-3)',
              padding: '4px',
            }}
            aria-label="Close popover"
          >
            <X size={14} />
          </button>
        </div>

        <div style={{ padding: '20px', maxHeight: '320px', overflowY: 'auto' }}>
          <div style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '4px' }}>
              {action.proposedActionSummary}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--ink-3)' }}>
              {action.actorLabel}
              {timestamp ? ` - ${new Date(timestamp).toLocaleString()}` : ''}
            </div>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <h4 style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px', color: 'var(--ink-2)' }}>
              Risk Assessment
            </h4>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <span style={{ fontSize: '12px', color: 'var(--ink-3)' }}>Risk Score:</span>
              <span style={{
                fontSize: '13px',
                fontWeight: 500,
                color: action.riskScore <= 0.3 ? 'var(--ok)' :
                  action.riskScore <= 0.7 ? 'var(--warn)' : 'var(--err)',
              }}>
                {Number(action.riskScore ?? 0).toFixed(2)}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '12px', color: 'var(--ink-3)' }}>Decision:</span>
              <span style={{
                fontSize: '12px',
                fontWeight: 500,
                color: decision === 'allow' ? 'var(--ok)' :
                  decision === 'needsApproval' ? 'var(--warn)' : 'var(--err)',
              }}>
                {decisionLabel}
              </span>
            </div>
          </div>

          {action.reasons && action.reasons.length > 0 && (
            <div style={{ marginBottom: '16px' }} data-testid="bucketing-reasons">
              <h4 style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px', color: 'var(--ink-2)' }}>
                Bucketing Reasons
              </h4>
              <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '12px', color: 'var(--ink-2)' }}>
                {action.reasons.map((reason: string, index: number) => (
                  <li key={index} style={{ marginBottom: '4px' }}>
                    {reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h4 style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px', color: 'var(--ink-2)' }}>
              Policy Decision Details
            </h4>
            <div style={{ fontSize: '12px', color: 'var(--ink-3)' }}>
              {action.actorType && (
                <div style={{ marginBottom: '4px' }}>
                  <strong>Actor Type:</strong> {action.actorType}
                </div>
              )}
              <div style={{ marginBottom: '4px' }}>
                <strong>Action ID:</strong> {action.actionId}
              </div>
              <div style={{ marginBottom: '4px' }}>
                <strong>Policy Decision ID:</strong> {action.policyDecisionId}
              </div>
              <div style={{ marginBottom: '4px' }}>
                <strong>Tenant ID:</strong> {action.tenantId}
              </div>
              <div style={{ marginBottom: '4px' }}>
                <strong>Proposed Action Kind:</strong> {action.proposedActionKind}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export default ActionDetailsPopover;
