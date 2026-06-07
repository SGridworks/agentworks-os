"use client";

import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { LucideIcon } from 'lucide-react';

export type NavKey =
  | 'mission-control'
  | 'memory-vault'
  | 'vault-health'
  | 'insights'
  | 'autopilot'
  | 'automations'
  | 'approvals'
  | 'issues'
  | 'review-queue'
  | 'triage-queue'
  | 'agents'
  | 'rule-packs'
  | 'scanner'
  | 'process-health'
  | 'activity'
  | 'evidence'
  | 'map'
  | 'settings'
  | 'trust'
  | 'active-work';

export const NAV_TO_PATH: Record<NavKey, string> = {
  'mission-control': '/mission-control',
  'memory-vault':    '/memory-vault',
  'vault-health':    '/vault-health',
  'insights':        '/insights',
  'autopilot':       '/autopilot',
  'automations':     '/automations',
  'approvals':       '/approvals',
  'issues':          '/issues',
  'review-queue':    '/review-queue',
  'triage-queue':    '/triage-queue',
  'agents':          '/agents',
  'rule-packs':      '/rule-packs',
  'scanner':         '/scanner',
  'process-health':  '/process-health',
  'activity':        '/activity',
  'evidence':        '/evidence',
  'map':             '/map',
  'settings':        '/settings',
  'trust':           '/trust',
  'active-work':     '/active-work',
};

export function useV2Nav() {
  const router = useRouter();
  return useCallback((k: NavKey) => router.push(NAV_TO_PATH[k]), [router]);
}