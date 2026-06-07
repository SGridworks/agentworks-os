import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { FlightRecorderTimeline } from './flight-recorder';

// Mock the API calls
vi.mock('@/lib/api', () => ({
  getSessionTimeline: vi.fn().mockResolvedValue({
    events: [
      {
        id: '1',
        type: 'action' as const,
        timestamp: '2024-01-01T12:00:00.000Z',
        actor: 'test-agent',
        summary: 'Test action',
        severity: 'allow' as const,
      },
      {
        id: '2',
        type: 'policy' as const,
        timestamp: '2024-01-01T12:00:01.000Z',
        actor: 'test-agent',
        summary: 'Policy evaluation',
        severity: 'allow' as const,
        hitId: 'hit-123',
      },
    ],
    nextCursor: null,
    prevCursor: null,
  }),
  getPolicyHitDetail: vi.fn().mockResolvedValue({
    id: 'hit-123',
    ruleId: 'rule-456',
    packName: 'test-pack',
    packVersion: '1.0.0',
    severity: 'allow',
    evidence: 'Test evidence',
    evidenceUrl: '/api/policy-hits/hit-123',
  }),
  downloadSessionTimelineCsv: vi.fn().mockResolvedValue(new Blob(['test'], { type: 'text/csv' })),
}));

// Mock date-fns
vi.mock('date-fns', () => ({
  format: vi.fn((date, formatStr) => '2024-01-01'),
}));

describe('FlightRecorderTimeline', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <FlightRecorderTimeline sessionId="test-session" />
    );
    
    expect(container).toBeTruthy();
  });

  it('displays the flight recorder header', () => {
    render(<FlightRecorderTimeline sessionId="test-session" />);
    
    expect(screen.getByText('Flight Recorder')).toBeInTheDocument();
  });

  it('shows export csv button', () => {
    render(<FlightRecorderTimeline sessionId="test-session" />);
    
    expect(screen.getByText('Export CSV')).toBeInTheDocument();
  });
});