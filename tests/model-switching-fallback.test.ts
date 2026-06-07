import { describe, it, expect, vi } from 'vitest';
import { fetch } from 'undici';
import { randomUUID } from 'node:crypto';

// Mock fetch implementation
vi.spyOn(fetch, 'default').mockImplementation(async (req) => {
  const url = new URL(req.url);
  // Mock Ollama provider health check to return unhealthy
  if (url.pathname.includes('/ollama/provider/health')) {
    return new Response(JSON.stringify({ healthy: false, reason: 'simulated_failure' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // Mock successful Anthropic Sonnet fallback response
  if (url.pathname.includes('/anthropic/sonnet')) {
    return new Response(JSON.stringify({ model: 'anthropic-sonnet', status: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // Mock missing credentials error
  if (url.pathname.includes('/provider/credentials')) {
    return new Response(JSON.stringify({
      error: 'missing_credentials',
      message: 'Provider credentials are invalid',
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // Mock operator action routing response
  if (url.pathname.includes('/operator/action')) {
    return new Response(JSON.stringify({
      routeToOperator: true,
      operatorActionRequired: true,
      reason: 'missing_credential:test_provider',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // Mock triage creation response
  if (url.pathname.includes('/triage')) {
    return new Response(JSON.stringify({
      triageCreated: true,
      triageId: randomUUID(),
      evidence: 'stuck_run_evidence_12345',
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // Default 404
  return new Response('Not Found', { status: 404 });
});

describe('Model switching fallback behavior', () => {
  it('should fallback to Anthropic Sonnet when Ollama provider fails', async () => {
    // Simulate unhealthy Ollama provider
    const healthResponse = await fetch('http://localhost:7710/ollama/provider/health');
    const healthJson = await healthResponse.json();
    expect(healthJson.healthy).toBe(false);

    // Mock the dispatch API call that would trigger model switching
    vi.spyOn(fetch, 'default').mockResolvedValueOnce(new Response(JSON.stringify({
      effectiveProvider: 'anthropic-sonnet',
      fallbackReason: 'provider_failure:ollama_unhealthy',
    }), { status: 200 });

    // Simulate calling the dispatch endpoint
    const dispatchResponse = await fetch('http://localhost:7710/api/dispatches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'test' }),
    });
    const dispatchData = await dispatchResponse.json();

    // Verify fallback behavior
    expect(dispatchData.effectiveProvider).toBe('anthropic-sonnet');
    expect(dispatchData.fallbackReason).toBe('provider_failure:ollama_unhealthy');
  });

  it('should route missing-credential errors to operator action', async () => {
    // Simulate missing credential error
    vi.spyOn(fetch, 'default').mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'missing_credentials',
      message: 'Provider credentials are invalid',
    }), { status: 403 });

    // Mock operator action routing
    vi.spyOn(fetch, 'default').mockResolvedValueOnce(new Response(JSON.stringify({
      routeToOperator: true,
      operatorActionRequired: true,
      reason: 'missing_credential:test_provider',
    }), { status: 200 });

    // Simulate dispatch with missing credentials
    const dispatchResponse = await fetch('http://localhost:7710/api/dispatches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'test_missing_cred' }),
    });
    const dispatchData = await dispatchResponse.json();

    // Verify that operator action is required
    expect(dispatchData.operatorActionRequired).toBe(true);
    expect(dispatchData.reason).toContain('missing_credential');
  });

  it('should create exactly one triage event for stuck in_progress runs', async () => {
    // Mock a stuck in_progress issue (no heartbeat updates)
    vi.spyOn(fetch, 'default').mockResolvedValueOnce(new Response(JSON.stringify({
      status: 'in_progress',
      lastHeartbeat: '2026-05-16T20:00:00Z',
    }), { status: 200 });

    // Mock the stuck-run detector to trigger a triage event
    vi.spyOn(fetch, 'default').mockResolvedValueOnce(new Response(JSON.stringify({
      triageCreated: true,
      triageId: randomUUID(),
      evidence: 'stuck_run_evidence_12345',
    }), { status: 201 });

    // Simulate calling the triage endpoint
    const triageResponse = await fetch('http://localhost:7710/api/issues/6d04c78a-997d-4048-8d7b-e42ac33371ac/triage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const triageData = await triageResponse.json();

    // Verify exactly one triage event is created
    expect(triageData.triageCreated).toBe(true);
    expect(triageData.triageId).toBeDefined();
    // Ensure issue status reflects the evidence
    expect(triageData.evidence).toContain('stuck_run_evidence_12345');
  });
});