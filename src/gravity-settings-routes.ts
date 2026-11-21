import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { GravitySettings, SettingsStore } from "./gravity-settings.js";
import type { QuotaReply } from "./gravity-quota.js";

export const ROUTE = "/dsh-oh-my-gravity";
const BODY_LIMIT = 64 * 1024;

/** What the page shows about AGY and the plugin; assembled by the host. */
export interface SettingsStatus {
  command: string;
  /** `agy --version`, or undefined when AGY did not run. */
  version?: string;
  /** AGY answered a session request, which it only does when signed in. */
  signedIn: boolean;
  /** The subscription tier AGY reports (for example "Google AI Pro"). */
  plan?: string;
  /** One entry per picker model, as AGY reports them, before any hiding. */
  models: { id: string; name: string }[];
  /** Models the profile's `models` config leaves out; the page cannot change those. */
  lockedModels: string[];
}
export interface SettingsDeps {
  settings: SettingsStore;
  /** `fresh`: ask AGY anew instead of answering from what is already known. */
  status: (fresh: boolean) => Promise<SettingsStatus>;
  /** Current Antigravity plan quota; optional for tests/hosts that omit quota probing. */
  quota?: (fresh: boolean) => Promise<QuotaReply>;
}

/** DSH's Host/Origin fence plus sign-in check: an HTTP status to refuse with, or undefined to let the request through. */
export type Reject = (req: IncomingMessage) => number | undefined;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const failure = (error: string, status: number) => json({ error }, status);

/** The body as text, or undefined once it passes `limit` bytes. The length is checked as chunks arrive, so an oversized or endless body is never held whole. */
async function readCapped(request: Request, limit: number): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); return undefined; }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

/** The Settings page's API: GET /api/status, GET /api/quota, POST /api/settings. Every failure is a JSON body with a status. */
export async function handleSettings(request: Request, { settings, status, quota }: SettingsDeps): Promise<Response> {
  const path = new URL(request.url).pathname.slice(ROUTE.length).replace(/\/+$/, "");
  const method = request.method.toUpperCase();
  // Only this page may use the API: a browser tab on another origin, even another localhost port, is refused.
  // A request with no such header is not from a browser page and is left to DSH's own sign-in gate.
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return failure("cross-origin request refused", 403);
  try {
    if (path === "/api/status") {
      if (method !== "GET") return failure("method not allowed", 405);
      return json({ ...(await status(new URL(request.url).searchParams.get("fresh") === "1")), settings: settings.get() });
    }
    if (path === "/api/quota") {
      if (method !== "GET") return failure("method not allowed", 405);
      if (!quota) return json({ ok: false, error: "quota unavailable" }, 501);
      return json(await quota(new URL(request.url).searchParams.get("fresh") === "1"));
    }
    if (path === "/api/settings") {
      if (method !== "POST") return failure("method not allowed", 405);
      // Requiring JSON means a browser must ask permission (a preflight) before another origin can send this.
      if (!/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? "")) return failure("expected application/json", 415);
      const text = await readCapped(request, BODY_LIMIT);
      if (text === undefined) return failure("body too large", 413);
      let body: unknown;
      try { body = JSON.parse(text); } catch { return failure("body is not JSON", 400); }
      const o = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
      const hidden = o?.hiddenModels;
      const tools = o?.dshTools;
      if (hidden === undefined && tools === undefined) return failure("expected hiddenModels and/or dshTools", 400);
      if (hidden !== undefined && !(Array.isArray(hidden) && hidden.every((id) => typeof id === "string" && id !== ""))) return failure("hiddenModels must be a list of model ids", 400);
      if (tools !== undefined && typeof tools !== "boolean") return failure("dshTools must be true or false", 400);
      const next: GravitySettings = { ...settings.get(), ...(hidden !== undefined ? { hiddenModels: hidden as string[] } : {}), ...(tools !== undefined ? { dshTools: tools } : {}) };
      settings.set(next);
      return json(next);
    }
    return failure("not found", 404);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), 500);
  }
}

/** Shares one in-flight run among concurrent callers and reuses a successful result for `ms`; a failure is neither shared later nor kept. */
export function throttled<T>(run: () => Promise<T>, ms: number): () => Promise<T> {
  let flight: Promise<T> | undefined;
  let last: { at: number; value: T } | undefined;
  return () => {
    if (last && Date.now() - last.at < ms) return Promise.resolve(last.value);
    return (flight ??= run().then(
      (value) => { last = { at: Date.now(), value }; flight = undefined; return value; },
      (error: unknown) => { flight = undefined; throw error; },
    ));
  };
}

/** The same API as a Node (req, res) route, which is what DSH needs for POST: its `resource` routes answer GET and HEAD only. */
export function nodeHandler(deps: SettingsDeps, reject: Reject): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const refused = reject(req);
      if (refused !== undefined) return fail(res, refused, refused === 503 ? "DSH connection service unavailable" : refused === 401 ? "DSH says not signed in (401)" : `DSH refused the request (${refused})`);
      // A fixed base: neither the Host header nor an absolute-form request line decides where this request "is".
      if (!req.url?.startsWith("/")) return fail(res, 400, "bad request target");
      const method = (req.method ?? "GET").toUpperCase();
      const hasBody = method !== "GET" && method !== "HEAD";
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const request = new Request(`http://localhost${req.url}`, {
        method, headers,
        ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half" } : {}),
      } as RequestInit);
      const response = await handleSettings(request, deps);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      // An oversized body was refused unread; drop the connection once the answer is out instead of draining it.
      if (response.status === 413) res.once("finish", () => req.destroy());
      res.end(method === "HEAD" ? undefined : await response.text());
    } catch {
      // Anything unexpected is an answer, never an unhandled rejection in DSH's web server.
      fail(res, 400, "bad request");
    }
  };
}

function fail(res: ServerResponse, status: number, error: string): void {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error }));
}
