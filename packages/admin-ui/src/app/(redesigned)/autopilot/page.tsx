'use client';

import { useState } from 'react';
import Button from '@/components/ui/button';
import Label from '@/components/ui/label';
import ActionDetailsPopover from '@/app/(redesigned)/autopilot/components/ActionDetailsPopover';

export default function AutopilotPage() {
  const buckets = [
    { id: 'safe', label: 'Safe' },
    { id: 'needsApproval', label: 'Needs Approval' },
    { id: 'risky', label: 'Risky' },
  ];

  // Sample items for demonstration
  const items = [
    {
      id: '1',
      bucketId: 'safe',
      proposedActionSummary: 'Dispatch items for safe bucket',
      actorLabel: 'System',
      createdAt: '2026-05-01T12:00:00Z',
      riskScore: 0.1,
      autopilotDecision: 'allow',
      policyDecisionId: 'pd-safe-1',
      reasons: ['Reason A', 'Reason B'],
    },
    {
      id: '2',
      bucketId: 'needsApproval',
      proposedActionSummary: 'Items pending approval',
      actorLabel: 'System',
      createdAt: '2026-05-01T12:01:00Z',
      riskScore: 0.4,
      autopilotDecision: 'needsApproval',
      policyDecisionId: 'pd-approval-1',
      reasons: ['Reason X', 'Reason Y'],
    },
    {
      id: '3',
      bucketId: 'risky',
      proposedActionSummary: 'High-risk items',
      actorLabel: 'System',
      createdAt: '2026-05-01T12:02:00Z',
      riskScore: 0.8,
      autopilotDecision: 'risky',
      policyDecisionId: 'pd-risky-1',
      reasons: ['Risk reason 1', 'Risk reason 2'],
    },
  ];

  // Popover state
  const [popover, setPopover] = useState({
    isOpen: false,
    action: null,
    position: { top: 0, left: 0 },
  });

  const openPopover = (item: any) => {
    setPopover({ isOpen: true, action: item, position: { top: 100, left: 100 } });
  };

  const closePopover = () => {
    setPopover(prev => ({ ...prev, isOpen: false }));
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4">
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col sm:flex-row gap-4 sm:gap-6 mb-8">
          <Button variant="primary" className="w-full sm:w-1/3" onClick={() => console.log('Dispatch all safe clicked')}>
            Dispatch all safe
          </Button>
          <Button variant="secondary" className="w-full sm:w-1/3" onClick={() => console.log('Approve all needs-approval clicked')}>
            Approve all needs-approval
          </Button>
          <Button variant="secondary" className="w-full sm:w-1/3" onClick={() => console.log('Acknowledge risky clicked')}>
            Acknowledge risky
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {buckets.map((bucket) => {
            const bucketItems = items.filter(item => item.bucketId === bucket.id);
            return (
              <div key={bucket.id} className="bg-gray-800 rounded-lg p-4 border border-gray-700">
                <Label className="font-medium mb-2">{bucket.label}</Label>
                <div className="space-y-2">
                  {bucketItems.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      {bucketItems.map(item => (
                        <button
                          key={item.id}
                          className="w-full bg-gray-700 text-gray-300 hover:bg-gray-600 py-1 px-2 rounded"
                          onClick={() => openPopover(item)}
                        >
                          {item.proposedActionSummary}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-gray-400 text-sm">—</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Render popover when open */}
        {popover.isOpen && popover.action && (
          <ActionDetailsPopover popover={popover} onClose={closePopover} />
        )}
      </div>
    </div>
  );
}
