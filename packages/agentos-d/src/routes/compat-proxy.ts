/**
 * Legacy bridge proxy.
 *
 * Transition surface for daemon-critical upstream routes while native AWOS
 * implementations land.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type { Config } from "../config.js";
import {
  recordCompatProxyEvent,
  type CompatProxyAuditInput,
} from "../services/compat-proxy-audit.js";
import { requestBuffer, type HttpRequestOptions, type HttpResponseBuffer } from "../http-client.js";

const ALLOWED_PREFIXES = [
  "/api/companies/",
  "/api/agents/",
  "/api/issues/",
  "/api/heartbeat-runs/",
  "/api/workspace-operations/",
  "/api/attachments/",
] as const;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function isAllowedCompatPath(path: string): boolean {
  return ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function upstreamHeaders(req: Request, config: Config): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value || HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else headers.set(key, value);
  }
  headers.set("authorization", req.header("authorization") ?? `Bearer ${config.legacyBridgeApiKey}`);
  headers.set("content-type", "application/json");
  headers.set("x-agentworks-compat-proxy", "agentos-d");
  return headers;
}

function responseHeaders(upstream: HttpResponseBuffer, res: Response): void {
  Object.entries(upstream.headers).forEach(([key, value]) => {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) return;
    res.setHeader(key, value);
  });
  res.setHeader("x-agentworks-compat-proxy", "agentos-d");
}

async function forward(req: Request, res: Response, config: Config): Promise<void> {
  const upstreamUrl = new URL(req.originalUrl, config.legacyBridgeUrl);
  const hasBody = !["GET", "HEAD"].includes(req.method.toUpperCase());
  const requestBody = hasBody ? JSON.stringify(req.body ?? {}) : "";
  const init: HttpRequestOptions = {
    method: req.method,
    headers: upstreamHeaders(req, config),
  };
  if (hasBody) init.body = requestBody;
  const upstream = await requestBuffer(upstreamUrl, init);

  const audit: CompatProxyAuditInput = {
    method: req.method,
    path: req.originalUrl,
    statusCode: upstream.status,
    requestBody,
    responseBody: upstream.body,
    forwardedTo: upstreamUrl.toString(),
  };
  const runId = req.header("x-agentworks-run-id");
  if (runId) audit.runId = runId;
  recordCompatProxyEvent(audit);
  responseHeaders(upstream, res);
  res.status(upstream.status).send(upstream.body);
}

export function createCompatProxyRouter(config: Config): Router {
  const router = Router();

  router.use(async (req, res, next) => {
    if (!config.legacyBridgeEnabled) {
      next();
      return;
    }
    if (!isAllowedCompatPath(req.originalUrl)) {
      next();
      return;
    }

    try {
      await forward(req, res, config);
    } catch (error) {
      const audit: CompatProxyAuditInput = {
        method: req.method,
        path: req.originalUrl,
        requestBody: JSON.stringify(req.body ?? {}),
        forwardedTo: new URL(req.originalUrl, config.legacyBridgeUrl).toString(),
        error: (error as Error).message,
      };
      const runId = req.header("x-agentworks-run-id");
      if (runId) audit.runId = runId;
      recordCompatProxyEvent(audit);
      req.log?.error({ err: error }, "compat proxy failed");
      res.status(502).json({
        error: "compat_proxy_failed",
        message: (error as Error).message,
      });
    }
  });

  return router;
}
