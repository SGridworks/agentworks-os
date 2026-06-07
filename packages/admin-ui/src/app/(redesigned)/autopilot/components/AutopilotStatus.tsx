import { Plane } from 'lucide-react';

export function AutopilotStatus() {
  return (
    <div style={{ 
      background: 'var(--bg-2)', 
      border: '1px solid var(--rule)', 
      borderRadius: 8, 
      padding: 16,
      marginTop: 24
    }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <Plane size={16} style={{ marginRight: 8, color: 'var(--accent)' }} />
        <h4 style={{ fontSize: 14, fontWeight: 500 }}>Autopilot Status</h4>
      </div>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0 }}>
          Safe actions (≤ 0.30) are eligible for dispatch, needs-approval actions (0.30-0.70) require human review, and risky actions (≥ 0.70) are blocked.
        </p>
    </div>
  );
}