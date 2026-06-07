import http from "node:http";
import https from "node:https";
import { Buffer } from "node:buffer";

export interface HttpRequestOptions {
  method?: string;
  headers?: Headers | Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
}

export interface HttpResponseBuffer {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function normalizeHeaders(headers?: Headers | Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!headers) return normalized;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      normalized[key] = value;
    });
    return normalized;
  }
  return { ...headers };
}

export function requestBuffer(
  url: string | URL,
  options: HttpRequestOptions = {},
): Promise<HttpResponseBuffer> {
  const target = typeof url === "string" ? new URL(url) : url;
  const transport = target.protocol === "https:" ? https : http;
  const body = options.body;
  const headers = normalizeHeaders(options.headers);
  if (body !== undefined && headers["content-length"] === undefined) {
    headers["content-length"] = String(Buffer.byteLength(body));
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(
      target,
      {
        method: options.method ?? "GET",
        headers,
        timeout: options.timeoutMs ?? 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) responseHeaders[key] = value.join(", ");
            else if (value !== undefined) responseHeaders[key] = String(value);
          }
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: responseHeaders,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error(`request timed out after ${options.timeoutMs ?? 30_000}ms`));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
