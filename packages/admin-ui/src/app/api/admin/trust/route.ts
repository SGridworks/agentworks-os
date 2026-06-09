/**
 * BFF proxy: GET /api/admin/trust?tenantId=<id>&fresh=1
 *
 * Proxies to agentos-d /api/admin/trust and passes through the enriched
 * TrustStatus shape (daemon, db, vault, profile, companies, agents,
 * dispatch, backup, inspector, warnings, providers).
 *
 * If the daemon endpoint is absent (pre-AGE-200 deploy), returns a
 * graceful empty payload so the UI renders without an error state.
 *
 * ?fresh=1 is forwarded to the daemon to bypass its 5s TTL cache.
 */

import { daemonFetch } from "@/lib/daemon-fetch";

export const dynamic = "force-dynamic";

interface TrustProvider {
  id: string;
  kind: "model_host" | "vector_store" | "object_store" | "sidecar" | "rule_pack";
  display_name: string;
  status: "healthy" | "degraded" | "down";
  last_ok: string;
  latency_ms: number | null;
  errors_last_24h: number;
  endpoint: string | null;
  note: string | null;
}

interface TrustCompany {
  name: string;
  expected: boolean;
  present: boolean;
  status: string | null;
}

interface TrustStatus {
  summary: "healthy" | "degraded" | "down";
  checked_at: string;
  providers: TrustProvider[];
  daemon?: {
    pid: number;
    version: string;
    startedAt: string;
    uptimeS: number;
  };
  db?: {
    path: string;
    sizeBytes: number;
    usingProfile: boolean;
    writable: boolean;
  };
  vault?: {
    path: string;
    fileCount: number;
    manifestUpdatedAt: string | null;
  };
  profile?: {
    loaded: boolean;
    path: string | null;
    version: number | null;
    drift: string[];
  };
  companies?: TrustCompany[];
  agents?: {
    active: number;
    paused: number;
    retired: number;
  };
  dispatch?: {
    queued: number;
    dispatched: number;
    stale: number;
    duplicateWakeups: number;
  };
  backup?: {
    backupDir: string;
    latestSnapshot: string | null;
    latestVerifiedAt: string | null;
  };
  inspector?: {
    listening: boolean;
  };
  warnings?: string[];
}

type DaemonProvider = Partial<TrustProvider> & {
  displayName?: string;
  category?: "llm" | "sidecar" | "storage" | "rules";
  lastSeen?: string;
  latencyMs?: number | null;
  error?: string | null;
};

type DaemonTrustResponse = Omit<Partial<TrustStatus>, "providers"> & {
  providers?: DaemonProvider[];
};

const VALID_KINDS = new Set(["model_host", "vector_store", "object_store", "sidecar", "rule_pack"]);
const VALID_STATUSES = new Set(["healthy", "degraded", "down"]);

function kindFromCategory(category: DaemonProvider["category"]): TrustProvider["kind"] {
  switch (category) {
    case "llm":
      return "model_host";
    case "storage":
      return "object_store";
    case "sidecar":
      return "sidecar";
    case "rules":
      return "rule_pack";
    default:
      return "model_host";
  }
}

function isValidProvider(p: unknown): p is TrustProvider {
  if (typeof p !== "object" || p === null) return false;
  const pp = p as Record<string, unknown>;
  if (typeof pp.id !== "string") return false;
  if (!VALID_KINDS.has(pp.kind as string)) return false;
  if (!VALID_STATUSES.has(pp.status as string)) return false;
  return true;
}

function normalise(daemon: DaemonTrustResponse): TrustStatus {
  const warnings = daemon.warnings ?? [];
  const agents = daemon.agents ?? { active: 0, paused: 0, retired: 0 };

  let summary: TrustStatus["summary"] = "healthy";
  if (warnings.length > 0 || agents.active === 0) {
    summary = "degraded";
  }

  const rawProviders = Array.isArray(daemon.providers) ? daemon.providers : [];
  const providers: TrustProvider[] = rawProviders
    .map((p) => ({
      id: p.id ?? "unknown",
      kind: (p.kind as TrustProvider["kind"]) ?? kindFromCategory(p.category),
      display_name: p.display_name ?? p.displayName ?? p.id ?? "Unknown",
      status: (p.status as TrustProvider["status"]) ?? "down",
      last_ok: p.last_ok ?? p.lastSeen ?? new Date().toISOString(),
      latency_ms: p.latency_ms ?? p.latencyMs ?? null,
      errors_last_24h: p.errors_last_24h ?? 0,
      endpoint: p.endpoint ?? null,
      note: p.note ?? p.error ?? null,
    }))
    .filter(isValidProvider);

  const result: TrustStatus = {
    summary,
    checked_at: new Date().toISOString(),
    providers,
    warnings,
  };

  // Pass through all enriched fields if present
  if (daemon.daemon) result.daemon = daemon.daemon;
  if (daemon.db) result.db = daemon.db;
  if (daemon.vault) result.vault = daemon.vault;
  if (daemon.profile) result.profile = daemon.profile;
  if (daemon.companies) result.companies = daemon.companies;
  if (daemon.agents) result.agents = daemon.agents;
  if (daemon.dispatch) result.dispatch = daemon.dispatch;
  if (daemon.backup) result.backup = daemon.backup;
  if (daemon.inspector) result.inspector = daemon.inspector;

  return result;
}

function emptyResponse(): TrustStatus {
  return {
    summary: "healthy",
    checked_at: new Date().toISOString(),
    providers: [],
    warnings: [],
  };
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const tenantId = url.searchParams.get("tenantId") ?? "";
  const fresh = url.searchParams.get("fresh") === "1";

  const daemonPath = new URLSearchParams();
  if (tenantId) daemonPath.set("tenantId", tenantId);
  if (fresh) daemonPath.set("fresh", "1");
  const qs = daemonPath.toString();
  const target = `/api/admin/trust${qs ? `?${qs}` : ""}`;

  try {
    const res = await daemonFetch(target, {
      headers: { "Content-Type": "application/json" },
      ...( { next: { revalidate: 0 } } as unknown as RequestInit ),
    });

    if (!res.ok) {
      if (res.status === 404) {
        console.warn("[trust] daemon /api/admin/trust returned 404; returning empty trust payload");
        return Response.json(emptyResponse());
      }
      const body = await res.text().catch(() => "");
      console.error("[trust] daemon error:", res.status, body);
      return Response.json(
        { error: "daemon_error", message: `${res.status}: ${body}` },
        { status: 502 }
      );
    }

    const daemonData = (await res.json()) as DaemonTrustResponse;
    return Response.json(normalise(daemonData));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[trust] fetch failed:", message);
    return Response.json(emptyResponse());
  }
}
