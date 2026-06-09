/**
 * SERVER-ONLY helper for making authenticated requests to the agentos-d daemon.
 *
 * Reads AGENTOS_API_URL and AGENTOS_API_KEY from server-side env at call time.
 * Never import this module into a client component — it would attempt to read
 * process.env secrets in the browser bundle.
 */

/**
 * Fetch a path on the daemon, injecting the owner Bearer token.
 *
 * - Resolves the full URL by prepending the daemon base.
 * - Merges caller headers/method/body; Authorization from the caller is
 *   overridden with the server-side owner token.
 * - Returns the raw Response so callers can stream or inspect as needed.
 */
export async function daemonFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const daemonBase = process.env.AGENTOS_API_URL ?? "http://127.0.0.1:7710";
  const ownerToken = process.env.AGENTOS_API_KEY ?? "local-trusted";
  const url = `${daemonBase}${path}`;

  const callerHeaders = new Headers(init?.headers as HeadersInit | undefined);
  callerHeaders.set("Authorization", `Bearer ${ownerToken}`);

  return fetch(url, {
    ...init,
    headers: callerHeaders,
  });
}
