/**
 * In-process TTL cache for the /api/admin/trust response.
 * Key is tenantId. TTL is 5 seconds.
 * The trust handler checks ?fresh=1 to bypass both read and write.
 */

const TTL_MS = 5_000;

interface CacheEntry {
  readonly value: unknown;
  readonly expiresAt: number;
}

const store = new Map<string, CacheEntry>();

export function getCached(tenantId: string): unknown | null {
  const entry = store.get(tenantId);
  if (entry === undefined) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(tenantId);
    return null;
  }
  return entry.value;
}

export function setCached(tenantId: string, response: unknown): void {
  store.set(tenantId, { value: response, expiresAt: Date.now() + TTL_MS });
}

export function invalidate(tenantId?: string): void {
  if (tenantId === undefined) {
    store.clear();
  } else {
    store.delete(tenantId);
  }
}
