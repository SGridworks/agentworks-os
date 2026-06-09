/**
 * GET /api/admin/vault-file?path=<rel>
 *
 * Reads a single markdown page through agentos-d so the admin UI carries the
 * owner token instead of reading the vault directly from the Next container.
 */

import { isAbsolute, normalize, sep } from "node:path";
import { daemonFetch } from "@/lib/daemon-fetch";

export const dynamic = "force-dynamic";

const TENANT_ID = process.env.AGENTOS_TENANT_ID;

interface MemoryReadResponse {
  ok: boolean;
  data?: {
    key: string;
    body: string;
    updatedAt: string;
    existed: boolean;
  };
  error?: string;
}

function normalizeRelativePath(rel: string): string | null {
  if (isAbsolute(rel)) return null;
  const normalized = normalize(rel);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) return null;
  if (!normalized.endsWith(".md")) return null;
  return normalized.split(sep).join("/");
}

export async function GET(req: Request): Promise<Response> {
  if (!TENANT_ID) {
    return Response.json(
      { error: "config_missing", message: "AGENTOS_TENANT_ID env var is required" },
      { status: 500 },
    );
  }

  const url = new URL(req.url);
  const rel = url.searchParams.get("path");
  if (!rel) {
    return Response.json({ error: "missing_path" }, { status: 400 });
  }

  const normalized = normalizeRelativePath(rel);
  if (!normalized) {
    return Response.json({ error: "invalid_path" }, { status: 400 });
  }

  const key = normalized.replace(/\.md$/i, "");
  try {
    const response = await daemonFetch("/api/memory/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: TENANT_ID, key }),
      cache: "no-store",
    });
    if (!response.ok) {
      return Response.json(
        { error: "read_failed", status: response.status },
        { status: response.status === 403 ? 403 : 502 },
      );
    }

    const payload = (await response.json()) as MemoryReadResponse;
    if (!payload.ok || !payload.data) {
      return Response.json({ error: payload.error ?? "read_failed" }, { status: 502 });
    }
    if (!payload.data.existed) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    return Response.json({
      path: normalized,
      title: normalized.split("/").pop()!.replace(/\.md$/i, ""),
      dir: normalized.split("/").slice(0, -1).join("/") || "/",
      content: payload.data.body,
      size: Buffer.byteLength(payload.data.body, "utf8"),
      mtime: Date.parse(payload.data.updatedAt),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[vault-file] failed:", message);
    return Response.json({ error: "read_failed", message }, { status: 500 });
  }
}
