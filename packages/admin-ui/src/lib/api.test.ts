import { describe, expect, it, vi } from 'vitest';
import { getApiBase } from './api';

describe('getApiBase', () => {
  it('always uses same-origin requests in the browser', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://127.0.0.1:7710');
    vi.stubEnv('AGENTOS_API_URL', 'http://127.0.0.1:7710');

    expect(getApiBase(true)).toBe('');

    vi.unstubAllEnvs();
  });

  it('uses AGENTOS_API_URL for server-side calls', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://wrong.example');
    vi.stubEnv('AGENTOS_API_URL', 'http://127.0.0.1:7710');

    expect(getApiBase(false)).toBe('http://127.0.0.1:7710');

    vi.unstubAllEnvs();
  });
});
