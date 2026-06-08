'use client';

import { AutopilotAction } from '@/lib/api';
import { EmptyState } from '@/components/v2/shell';
import { AlertTriangle, CheckCircle, Clock, RefreshCw, Plane } from 'lucide-react';

interface ActionBucketProps {
  bucket: 'safe' | 'needsApproval' | 'risky';
  actions: AutopilotAction[];
  loading: boolean;
  processing: boolean;
  onBulkAction: (bucket: 'safe' | 'needsApproval' | 'risky') => void;
  onActionClick: (action: AutopilotAction, event: React.MouseEvent) => void;
}

export function ActionBucket({
  bucket,
  actions,
  loading,
  processing,
  onBulkAction,
  onActionClick
}: ActionBucketProps) {
  function getBucketLabel(bucket: 'safe' | 'needsApproval' | 'risky'): string {
    switch (bucket) {
      case 'safe': return 'Safe';
      case 'needsApproval': return 'Needs Approval';
      case 'risky': return 'Risky';
    }
  }

  function getBucketIcon(bucket: 'safe' | 'needsApproval' | 'risky') {
    switch (bucket) {
      case 'safe': return CheckCircle;
      case 'needsApproval': return Clock;
      case 'risky': return AlertTriangle;
    }
  }

  function getBucketColor(bucket: 'safe' | 'needsApproval' | 'risky'): string {
    switch (bucket) {
      case 'safe': return 'var(--success)';
      case 'needsApproval': return 'var(--warn)';
      case 'risky': return 'var(--error)';
    }
  }

  function getActionButtonLabel(bucket: 'safe' | 'needsApproval' | 'risky'): string {
    switch (bucket) {
      case 'safe': return 'Dispatch All Safe';
      case 'needsApproval': return 'Approve All Needs-Approval';
      case 'risky': return 'Acknowledge All Risky';
    }
  }

  const Icon = getBucketIcon(bucket);
  const color = getBucketColor(bucket);
  const label = getBucketLabel(bucket);
  const buttonLabel = getActionButtonLabel(bucket);

  return (
    <div style={{
      border: '1px solid var(--rule)',
      borderRadius: 8,
      padding: 20,
      background: 'var(--bg-card)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
        <Icon size={20} strokeWidth={1.6} style={{ color, marginRight: 8 }} />
        <h3 style={{ fontSize: 16, fontWeight: 500 }}>{label}</h3>
        <span style={{
          marginLeft: 'auto',
          background: color,
          color: 'white',
          padding: '2px 8px',
          borderRadius: 12,
          fontSize: 12,
          fontWeight: 500
        }}>
          {actions.length}
        </span>
      </div>

      <div style={{ marginBottom: 16, minHeight: 200 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--ink-3)' }}>
            <RefreshCw size={16} style={{ marginBottom: 8, animation: 'spin 1s linear infinite' }} />
            Loading...
          </div>
        ) : actions.length === 0 ? (
          <EmptyState
            icon={Icon}
            title={`No ${label.toLowerCase()} actions`}
            body={`There are currently no actions categorized as ${label.toLowerCase()}.`}
          />
        ) : (
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            {actions.slice(0, 5).map(action => (
              <div
                key={action.id}
                style={{
                  padding: '12px',
                  border: '1px solid var(--rule-2)',
                  borderRadius: 4,
                  marginBottom: 8,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  position: 'relative'
                }}
                onClick={(e) => onActionClick(action, e)}
                className="action-item"
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
                  e.currentTarget.style.borderColor = 'var(--rule)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = '';
                  e.currentTarget.style.borderColor = 'var(--rule-2)';
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                  {action.proposedActionSummary}
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 6 }}>
                  {action.actorLabel} • {new Date(action.createdAt).toLocaleString()}
                </div>
                <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                  Risk Score: {action.riskScore.toFixed(2)}
                  {action.reasons.length > 0 && (
                    <span style={{ marginLeft: 8 }}>
                      Reasons: {action.reasons.slice(0, 2).join(', ')}
                      {action.reasons.length > 2 && ` +${action.reasons.length - 2} more`}
                    </span>
                  )}
                </div>
              </div>
            ))}
            {actions.length > 5 && (
              <div style={{
                textAlign: 'center',
                padding: '8px',
                color: 'var(--ink-3)',
                fontSize: 12
              }}>
                +{actions.length - 5} more actions
              </div>
            )}
          </div>
        )}
      </div>

      <button
        className="btn btn-primary"
        style={{ width: '100%' }}
        onClick={() => onBulkAction(bucket)}
        disabled={actions.length === 0 || processing}
      >
        {processing ? (
          <>
            <RefreshCw size={14} style={{ marginRight: 6, animation: 'spin 1s linear infinite' }} />
            Processing...
          </>
        ) : (
          <>
            <Plane size={14} style={{ marginRight: 6 }} />
            {buttonLabel}
          </>
        )}
      </button>
    </div>
  );
}
