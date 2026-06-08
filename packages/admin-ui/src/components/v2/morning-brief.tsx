'use client';

import { useCallback, useEffect, useState } from 'react';
import { getMorningBrief, dismissMorningBrief, type MorningBriefResponse, type MorningBriefItem } from '@/lib/api';
import { Briefcase, ExternalLink } from 'lucide-react';

interface MorningBriefProps {
  tenantId: string;
  onNav: (path: string) => void;
}

export default function MorningBrief({ tenantId, onNav }: MorningBriefProps) {
  const [brief, setBrief] = useState<MorningBriefResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [dismissing, setDismissing] = useState(false);

  // localStorage key generation and checking
  const getDismissalKey = useCallback((generatedAt: string): string => {
    const date = new Date(generatedAt);
    const dayKey = date.toISOString().split('T')[0]; // YYYY-MM-DD format
    return `dismissed-brief-${tenantId}-${dayKey}`;
  }, [tenantId]);

  const isDismissed = useCallback((generatedAt: string): boolean => {
    if (typeof window === 'undefined') return false;
    const key = getDismissalKey(generatedAt);
    return localStorage.getItem(key) === 'true';
  }, [getDismissalKey]);

  const markDismissed = useCallback((generatedAt: string): void => {
    if (typeof window === 'undefined') return;
    const key = getDismissalKey(generatedAt);
    localStorage.setItem(key, 'true');
  }, [getDismissalKey]);

  useEffect(() => {
    let cancelled = false;

    async function loadBrief() {
      try {
        const data = await getMorningBrief(tenantId);
        if (!cancelled) {
          // Check if this brief has been dismissed for its generation day
          if (data && isDismissed(data.generated_at)) {
            setBrief(null);
          } else {
            setBrief(data);
          }
        }
      } catch (err) {
        console.error('Failed to load morning brief:', err);
        if (!cancelled) {
          setBrief(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadBrief();
    return () => { cancelled = true; };
  }, [tenantId, isDismissed]);

  const handleDismiss = async () => {
    if (!brief || dismissing) return;

    setDismissing(true);
    try {
      await dismissMorningBrief(tenantId);
      // Mark as dismissed in localStorage using the generation date
      markDismissed(brief.generated_at);
      setBrief(null);
    } catch (err) {
      console.error('Failed to dismiss morning brief:', err);
    } finally {
      setDismissing(false);
    }
  };

  const handleActionClick = (href: string) => {
    if (href.startsWith('/')) {
      onNav(href);
    } else {
      // For external URLs, use window.location or handle differently
      window.location.href = href;
    }
  };

  if (loading) {
    return null; // Don't render anything while loading
  }

  if (!brief || !brief.items.length) {
    return null; // Don't render if no brief or no items
  }

  const hasBlockSeverity = brief.items.some(item => item.severity === 'block');
  const accentColor = hasBlockSeverity ? 'var(--err)' : 'var(--info)';
  const borderColor = hasBlockSeverity ? 'var(--err)' : 'var(--rule)';

  return (
    <div style={{ margin: '0 28px 16px' }}>
      <div
        className="card"
        style={{
          border: `1px solid ${borderColor}`,
          background: 'var(--bg-card)',
          padding: '16px 20px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
          <Briefcase size={18} style={{ color: accentColor, flexShrink: 0, marginTop: 2 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
                Morning Brief — {brief.items.length} item{brief.items.length !== 1 ? 's' : ''} needing attention
              </span>
              <button
                onClick={handleDismiss}
                disabled={dismissing}
                style={{
                  background: 'none',
                  border: '1px solid var(--ink-3)',
                  color: 'var(--ink-2)',
                  padding: '4px 8px',
                  fontSize: 11,
                  fontFamily: "'JetBrains Mono', monospace",
                  borderRadius: 2,
                  cursor: dismissing ? 'not-allowed' : 'pointer',
                  opacity: dismissing ? 0.6 : 1,
                }}
              >
                {dismissing ? 'Dismissing…' : 'Dismiss until tomorrow'}
              </button>
            </div>
            <div style={{ display: 'grid', gap: 12 }}>
              {brief.items.map((item, index) => (
                <MorningBriefItem key={item.id} item={item} index={index} onActionClick={handleActionClick} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface MorningBriefItemProps {
  item: MorningBriefItem;
  index: number;
  onActionClick: (href: string) => void;
}

function MorningBriefItem({ item, index, onActionClick }: MorningBriefItemProps) {
  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'block': return 'var(--err)';
      case 'review': return 'var(--warn)';
      case 'info': return 'var(--info)';
      default: return 'var(--ink-3)';
    }
  };

  const getSeverityLabel = (severity: string) => {
    switch (severity) {
      case 'block': return 'BLOCK';
      case 'review': return 'REVIEW';
      case 'info': return 'INFO';
      default: return 'INFO';
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '12px 0',
        borderTop: index > 0 ? '1px dashed var(--rule)' : 'none',
      }}
    >
      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: '50%',
          background: getSeverityColor(item.severity),
          color: 'white',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 10,
          fontWeight: 600,
          fontFamily: "'JetBrains Mono', monospace",
          flexShrink: 0,
        }}
      >
        {index + 1}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              fontFamily: "'JetBrains Mono', monospace",
              color: getSeverityColor(item.severity),
              textTransform: 'uppercase',
            }}
          >
            {getSeverityLabel(item.severity)}
          </span>
          <span style={{ fontSize: 11, color: 'var(--ink-3)', fontFamily: "'JetBrains Mono', monospace" }}>
            {item.kind.replace('_', ' ')}
          </span>
        </div>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink)', marginBottom: 4 }}>
          {item.title}
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.4, marginBottom: 8 }}>
          {item.body}
        </div>
        <button
          onClick={() => onActionClick(item.call_to_action.href)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            background: 'none',
            border: '1px solid var(--ink-3)',
            color: 'var(--ink-2)',
            padding: '4px 8px',
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            borderRadius: 2,
            cursor: 'pointer',
          }}
        >
          {item.call_to_action.label}
          <ExternalLink size={12} />
        </button>
      </div>
    </div>
  );
}
