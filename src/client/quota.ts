export type QuotaFamily = "gemini" | "third-party" | "other";
export type QuotaWindow = "5h" | "weekly" | "other";

export interface QuotaBucket {
  id: string;
  label: string;
  family: QuotaFamily;
  window: QuotaWindow;
  remainingPercent: number;
  usedPercent: number;
  resetsAt: number | null;
  disabled?: boolean;
}

export type QuotaReply =
  | {
      ok: true;
      fetchedAt: number;
      plan?: string;
      email?: string;
      buckets: QuotaBucket[];
    }
  | {
      ok: false;
      error: string;
      fetchedAt?: number;
    };

export const ROUTE = "/dsh-oh-my-gravity";

const CLIENT_CACHE_MS = 30_000;
let cached: { at: number; reply: QuotaReply } | undefined;
let inFlightNormal: Promise<QuotaReply> | undefined;
let inFlightFresh: Promise<QuotaReply> | undefined;

async function fetchQuota(fresh: boolean): Promise<QuotaReply> {
  try {
    const response = await fetch(`${ROUTE}/api/quota${fresh ? "?fresh=1" : ""}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    const body = (await response.json().catch(() => null)) as QuotaReply | null;
    if (!body || typeof body !== "object" || typeof body.ok !== "boolean") {
      return { ok: false, error: `request failed (${response.status})` };
    }
    if (body.ok) cached = { at: Date.now(), reply: body };
    return body;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function loadQuota(fresh = false): Promise<QuotaReply> {
  if (!fresh) {
    if (cached && Date.now() - cached.at < CLIENT_CACHE_MS) {
      return Promise.resolve(cached.reply);
    }
    return (inFlightNormal ??= fetchQuota(false).finally(() => {
      inFlightNormal = undefined;
    }));
  }
  return (inFlightFresh ??= fetchQuota(true).finally(() => {
    inFlightFresh = undefined;
  }));
}

export function formatReset(resetsAt: number | null, now = Date.now()): string {
  if (resetsAt === null) return "";
  const ms = resetsAt - now;
  if (ms <= 0) return "resets now";
  if (ms < 86_400_000) {
    const totalMin = Math.max(1, Math.round(ms / 60_000));
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
  }
  return `resets ${new Date(resetsAt).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function targetFamilyForModel(model?: string): "gemini" | "third-party" {
  if (!model || model === "default") return "gemini";
  if (/claude|gpt/i.test(model)) return "third-party";
  return "gemini";
}

export function orderBucketsForModel(buckets: readonly QuotaBucket[], model?: string): QuotaBucket[] {
  const family = targetFamilyForModel(model);
  const primary: QuotaBucket[] = [];
  const secondary: QuotaBucket[] = [];
  for (const bucket of buckets) {
    if (bucket.family === family) primary.push(bucket);
    else secondary.push(bucket);
  }
  return [...primary, ...secondary];
}

export function bindingBucketsForModel(buckets: readonly QuotaBucket[], model?: string): QuotaBucket[] {
  const family = targetFamilyForModel(model);
  const matching = buckets.filter((b) => b.family === family);
  return matching.length > 0 ? matching : [...buckets];
}

export function remainingTone(remainingPercent: number): "err" | "warn" | "ok" {
  if (remainingPercent <= 10) return "err";
  if (remainingPercent <= 25) return "warn";
  return "ok";
}

export function formatPercent(value: number): string {
  const clamped = Math.max(0, Math.min(100, value));
  return `${Math.round(clamped)}%`;
}
