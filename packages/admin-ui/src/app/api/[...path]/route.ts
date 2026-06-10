/**
 * Catch-all proxy: forwards any /api/* browser request to agentos-d via
 * daemonFetch, which injects the owner Bearer token.
 *
 * Next.js App Router prefers more-specific segments, so the dedicated BFF
 * handlers under /api/admin/** take precedence over this catch-all for those
 * paths. This route covers everything else (e.g. /api/tenants, /api/companies,
 * /api/issues/*, /api/memory/*, /api/dispatch/*, etc.).
 */

import { type NextRequest, NextResponse } from "next/server";
import { daemonFetch } from "@/lib/daemon-fetch";

export const dynamic = "force-dynamic";

async function proxy(req: NextRequest): Promise<NextResponse> {
  const incoming = new URL(req.url);

  // Rebuild the target path + query string.
  const target = `${incoming.pathname}${incoming.search}`;

  const res = await daemonFetch(target, {
    method: req.method,
    headers: req.headers,
    body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    // @ts-expect-error — Next fetch extension; pass through for streaming
    duplex: "half",
  });

  // Stream daemon response body back to the browser with original status/headers.
  const headers = new Headers(res.headers);
  // Strip hop-by-hop headers that must not be forwarded.
  headers.delete("transfer-encoding");

  return new NextResponse(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
