import { describe, it, expect, vi } from 'vitest';
import { redirect } from 'next/navigation';

// Mock the redirect function
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
}));

describe('RootPage', () => {
  it('should redirect to mission-control', async () => {
    const { redirect } = await import('next/navigation');
    const { default: RootPage } = await import('./page');

    await RootPage();

    expect(redirect).toHaveBeenCalledWith('/mission-control');
  });
});
