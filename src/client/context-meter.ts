import {
  bindingBucketsForModel,
  formatPercent,
  formatReset,
  loadQuota,
  orderBucketsForModel,
  remainingTone,
  type QuotaBucket,
  type QuotaReply,
} from "./quota.js";
import { createMangoSvg } from "./styles.js";

export interface MeterClientCtx {
  sessions?: {
    list?: {
      subscribe?: (fn: () => void) => () => void;
      getSnapshot?: () => {
        byId?: Record<
          string,
          {
            retainedBy?: Record<string, number>;
            projectionValues?: {
              modelSelection?: {
                lastUsed?: { provider?: string; model?: string } | null;
                next?: { provider?: string; model?: string } | null;
              };
            };
          }
        >;
      };
    };
  };
  modelDirectories?: {
    directoryFor?: (id: string) => {
      store?: {
        getSnapshot?: () => {
          current?: { provider?: string; model?: string };
        };
      };
    };
  };
}

const MARK = "data-omg-quota";
const TINT_MARK = "data-omg-tint";
const ARC_SEL = ':scope > button[aria-haspopup="dialog"] circle + circle';

const TONE_COLOR = {
  err: "var(--dsw-alias-state-error-primary, #dc2626)",
  warn: "var(--dsw-alias-state-warn-primary, #d9822b)",
  ok: "var(--dsw-alias-state-success-primary, #16a34a)",
} as const;

const isRingRoot = (el: HTMLElement | null): boolean => !!el?.querySelector(ARC_SEL);

function isInactiveContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("inactive context");
}

function activeAntigravityModel(ctx: MeterClientCtx): { active: boolean; model?: string } {
  try {
    const byId = ctx.sessions?.list?.getSnapshot?.()?.byId;
    if (!byId) return { active: false };
    let openId: string | undefined;
    for (const [id, summary] of Object.entries(byId)) {
      if ((summary?.retainedBy?.mainView ?? 0) > 0) {
        openId = id;
        break;
      }
    }
    if (!openId) return { active: false };

    try {
      const live = ctx.modelDirectories?.directoryFor?.(openId)?.store?.getSnapshot?.()?.current;
      if (live?.provider !== undefined) {
        return { active: live.provider === "antigravity", model: live.model };
      }
    } catch {
      // Directory may not be bound yet; fall back to session summary projection.
    }
    const sel = byId[openId]?.projectionValues?.modelSelection;
    const picked = sel?.next ?? sel?.lastUsed ?? undefined;
    return { active: picked?.provider === "antigravity", model: picked?.model };
  } catch (error) {
    if (isInactiveContextError(error)) throw error;
    return { active: false };
  }
}

function shortWindowLabel(bucket: QuotaBucket): string {
  if (bucket.window === "5h") return "5h";
  if (bucket.window === "weekly") return "weekly";
  return bucket.label;
}

function renderPopoverContent(
  host: HTMLElement,
  reply: QuotaReply,
  model: string | undefined,
  onRefresh: () => void,
  refreshing: boolean,
): void {
  host.replaceChildren();

  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px";

  const titleWrap = document.createElement("div");
  titleWrap.style.cssText = "display:flex;align-items:center;gap:6px;font-weight:600;color:var(--dsw-alias-label-primary, inherit)";
  const icon = createMangoSvg(13);
  icon.style.flex = "0 0 auto";
  const titleText = document.createElement("span");
  titleText.textContent = "Antigravity Quota";
  titleWrap.append(icon, titleText);
  if (reply.ok && reply.plan) {
    const plan = document.createElement("span");
    plan.style.cssText = "font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary, rgba(128,128,128,.75))";
    plan.textContent = `· ${reply.plan}`;
    titleWrap.append(plan);
  }

  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.textContent = refreshing ? "…" : "↻";
  refreshBtn.title = "Refresh quota";
  refreshBtn.setAttribute("aria-label", "Refresh Antigravity quota");
  refreshBtn.disabled = refreshing;
  refreshBtn.style.cssText =
    "appearance:none;border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));background:transparent;color:var(--dsw-alias-label-secondary, rgba(128,128,128,.85));border-radius:5px;padding:1px 6px;font-size:11px;line-height:1.4;cursor:pointer";
  refreshBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    onRefresh();
  });

  header.append(titleWrap, refreshBtn);
  host.append(header);

  if (!reply.ok) {
    const err = document.createElement("div");
    err.style.cssText = "font-size:12px;color:var(--dsw-alias-label-tertiary, rgba(128,128,128,.75))";
    err.textContent = `Quota unavailable: ${reply.error}`;
    host.append(err);
    return;
  }

  const ordered = orderBucketsForModel(reply.buckets, model);
  for (const bucket of ordered) {
    const tone = TONE_COLOR[remainingTone(bucket.remainingPercent)];
    const pct = Math.max(0, Math.min(100, bucket.remainingPercent));

    const row = document.createElement("div");
    row.style.cssText = "display:grid;grid-template-columns:1fr auto;align-items:baseline;column-gap:12px;row-gap:3px;padding:3px 0";

    const label = document.createElement("span");
    label.style.cssText = "color:var(--dsw-alias-label-primary, inherit);font-weight:500;font-size:12px";
    label.textContent = bucket.label + (bucket.disabled ? " (paused)" : "");

    const val = document.createElement("span");
    val.style.cssText = `font-variant-numeric:tabular-nums;font-weight:600;font-size:12px;color:${tone}`;
    val.textContent = `${formatPercent(pct)} left`;

    const bar = document.createElement("div");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(Math.round(pct)));
    bar.setAttribute("aria-label", `${bucket.label} ${formatPercent(pct)} remaining`);
    bar.style.cssText = "grid-column:1 / -1;height:4px;border-radius:2px;background:var(--dsw-alias-border-l2, rgba(128,128,128,.22));overflow:hidden";

    const fill = document.createElement("div");
    fill.style.cssText = `height:100%;width:${pct}%;border-radius:2px;background:${tone}`;
    bar.append(fill);

    const reset = formatReset(bucket.resetsAt);
    row.append(label, val, bar);
    if (reset) {
      const meta = document.createElement("span");
      meta.style.cssText = "grid-column:1 / -1;color:var(--dsw-alias-label-tertiary, rgba(128,128,128,.75));font-size:11px;line-height:15px";
      meta.textContent = reset;
      row.append(meta);
    }
    host.append(row);
  }
}

function renderTooltipContent(host: HTMLElement, reply: QuotaReply, model: string | undefined): void {
  host.replaceChildren();
  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:flex-start;gap:6px";
  const icon = createMangoSvg(12);
  icon.style.cssText = "flex:0 0 auto;margin-top:2px;color:var(--dsw-alias-label-secondary, rgba(128,128,128,.85))";
  const text = document.createElement("span");
  if (!reply.ok) {
    text.textContent = `Antigravity · quota unavailable`;
  } else {
    const binding = bindingBucketsForModel(reply.buckets, model);
    const parts = binding.map((b) => `${shortWindowLabel(b)} ${formatPercent(b.remainingPercent)} left`);
    text.textContent = parts.length > 0 ? `Antigravity · ${parts.join(" · ")}` : "Antigravity";
  }
  row.append(icon, text);
  host.append(row);
}

/**
 * Mounts Antigravity quota inside DSH's context-meter tooltip and popover when the active
 * session is on the `antigravity` provider, and tints the ring when a quota window runs low.
 */
export function watchContextMeter(ctx: MeterClientCtx): () => void {
  let arc: SVGCircleElement | undefined;
  let quotaReply: QuotaReply | undefined;
  let lastFetch = 0;
  let disposed = false;
  let frameQueued = false;
  let refreshing = false;

  const portalPanel = (): HTMLElement | null => {
    const trigger = arc?.closest("button");
    if (!trigger || trigger.getAttribute("aria-expanded") !== "true") return null;
    const label = trigger.getAttribute("aria-label");
    if (!label) return null;
    for (const panel of document.querySelectorAll<HTMLElement>('[role="dialog"]')) {
      if (panel.contains(trigger)) continue;
      const own = panel.getAttribute("aria-label");
      if (own && own !== label && label.includes(own)) return panel;
    }
    return null;
  };

  const isRingTip = (tip: HTMLElement): boolean => {
    if (isRingRoot(tip.parentElement)) return true;
    const ring = arc?.closest("button");
    if (tip.parentElement !== document.body || !tip.hasAttribute("data-portal")) return false;
    if (ring?.matches(":hover, :focus-visible") !== true) return false;
    const box = tip.getBoundingClientRect();
    const r = ring.getBoundingClientRect();
    const near = 24;
    return box.left < r.right + near && box.right > r.left - near && box.top < r.bottom + near && box.bottom > r.top - near;
  };

  const refreshQuota = (fresh: boolean) => {
    if (disposed) return;
    if (fresh) refreshing = true;
    lastFetch = Date.now();
    void loadQuota(fresh).then((reply) => {
      if (disposed) return;
      refreshing = false;
      quotaReply = reply;
      runPass();
    });
  };

  const attachPopover = (panel: HTMLElement, model: string | undefined) => {
    let block = panel.querySelector<HTMLElement>(`:scope > [${MARK}]`);
    if (!block) {
      block = document.createElement("div");
      block.setAttribute(MARK, "popover");
      block.style.cssText =
        "border-bottom:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.22));margin-bottom:10px;padding-bottom:8px;font-size:13px;line-height:20px";
      panel.prepend(block);
    }
    if (!quotaReply) {
      block.textContent = "Loading Antigravity quota…";
      if (Date.now() - lastFetch > 5_000) refreshQuota(false);
      return;
    }
    renderPopoverContent(block, quotaReply, model, () => {
      refreshQuota(true);
      runPass();
    }, refreshing);
  };

  const attachTooltip = (tip: HTMLElement, model: string | undefined) => {
    let block = tip.querySelector<HTMLElement>(`:scope > [${MARK}]`);
    if (!block) {
      block = document.createElement("div");
      block.setAttribute(MARK, "tooltip");
      block.style.cssText =
        "max-width:min(80vw,420px);white-space:normal;overflow-wrap:anywhere;padding-bottom:4px;margin-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.22))";
      tip.prepend(block);
    }
    if (!quotaReply) {
      block.textContent = "Antigravity · loading quota…";
      if (Date.now() - lastFetch > 5_000) refreshQuota(false);
      return;
    }
    renderTooltipContent(block, quotaReply, model);
  };

  const paintRingTint = (active: boolean, model: string | undefined) => {
    if (arc?.isConnected !== true) return;
    let stroke = "";
    if (active && quotaReply?.ok) {
      const binding = bindingBucketsForModel(quotaReply.buckets, model);
      let minRemaining = Infinity;
      for (const b of binding) {
        if (!b.disabled && b.remainingPercent < minRemaining) minRemaining = b.remainingPercent;
      }
      if (minRemaining <= 5) stroke = TONE_COLOR.err;
      else if (minRemaining <= 15) stroke = TONE_COLOR.warn;
    }
    if (stroke) {
      if (arc.style.stroke !== stroke) arc.style.stroke = stroke;
      arc.setAttribute(TINT_MARK, "1");
    } else if (arc.hasAttribute(TINT_MARK)) {
      arc.style.stroke = "";
      arc.removeAttribute(TINT_MARK);
    }
  };

  const cleanupForeign = () => {
    for (const el of document.querySelectorAll(`[${MARK}]`)) el.remove();
    if (arc?.hasAttribute(TINT_MARK)) {
      arc.style.stroke = "";
      arc.removeAttribute(TINT_MARK);
    }
  };

  const runPass = () => {
    frameQueued = false;
    if (disposed) return;

    let state: { active: boolean; model?: string };
    try {
      state = activeAntigravityModel(ctx);
    } catch (error) {
      if (isInactiveContextError(error)) dispose();
      return;
    }

    if (arc?.isConnected !== true) {
      arc = undefined;
      for (const btn of document.querySelectorAll<HTMLElement>('button[aria-haspopup="dialog"]')) {
        const host = btn.parentElement;
        const found = host && isRingRoot(host) ? host.querySelector<SVGCircleElement>(ARC_SEL) : null;
        if (found) {
          arc = found;
          break;
        }
      }
    }

    if (!state.active) {
      cleanupForeign();
      return;
    }

    if (Date.now() - lastFetch > 30_000) {
      refreshQuota(false);
    }

    for (const el of document.querySelectorAll<HTMLElement>('[role="dialog"]')) {
      if (isRingRoot(el.parentElement)) attachPopover(el, state.model);
    }
    const portal = portalPanel();
    if (portal) attachPopover(portal, state.model);

    for (const tip of document.querySelectorAll<HTMLElement>('[role="tooltip"]')) {
      if (isRingTip(tip)) attachTooltip(tip, state.model);
    }

    paintRingTint(true, state.model);
  };

  const schedule = () => {
    if (disposed || frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(runPass);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });

  let offList: (() => void) | undefined;
  try {
    offList = ctx.sessions?.list?.subscribe?.(schedule);
  } catch (error) {
    if (isInactiveContextError(error)) {
      observer.disconnect();
      return () => {};
    }
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    try {
      offList?.();
    } catch { /* ignore on teardown */ }
    cleanupForeign();
  };

  runPass();
  return dispose;
}
