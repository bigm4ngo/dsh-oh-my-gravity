window.__ModuleLoader__.load({ id: "dsh-oh-my-gravity", factory: (hostRequire) => {
var __modules = {
  "./context-meter.js": function(require, exports, module) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.watchContextMeter = watchContextMeter;
const quota_js_1 = require("./quota.js");
const styles_js_1 = require("./styles.js");
const MARK = "data-omg-quota";
const TINT_MARK = "data-omg-tint";
const ARC_SEL = ':scope > button[aria-haspopup="dialog"] circle + circle';
const TONE_COLOR = {
    err: "var(--dsw-alias-state-error-primary, #dc2626)",
    warn: "var(--dsw-alias-state-warn-primary, #d9822b)",
    ok: "var(--dsw-alias-state-success-primary, #16a34a)",
};
const isRingRoot = (el) => !!el?.querySelector(ARC_SEL);
function isInactiveContextError(error) {
    return error instanceof Error && error.message.includes("inactive context");
}
function activeAntigravityModel(ctx) {
    try {
        const byId = ctx.sessions?.list?.getSnapshot?.()?.byId;
        if (!byId)
            return { active: false };
        let openId;
        for (const [id, summary] of Object.entries(byId)) {
            if ((summary?.retainedBy?.mainView ?? 0) > 0) {
                openId = id;
                break;
            }
        }
        if (!openId)
            return { active: false };
        try {
            const live = ctx.modelDirectories?.directoryFor?.(openId)?.store?.getSnapshot?.()?.current;
            if (live?.provider !== undefined) {
                return { active: live.provider === "antigravity", model: live.model };
            }
        }
        catch {
            // Directory may not be bound yet; fall back to session summary projection.
        }
        const sel = byId[openId]?.projectionValues?.modelSelection;
        const picked = sel?.next ?? sel?.lastUsed ?? undefined;
        return { active: picked?.provider === "antigravity", model: picked?.model };
    }
    catch (error) {
        if (isInactiveContextError(error))
            throw error;
        return { active: false };
    }
}
function shortWindowLabel(bucket) {
    if (bucket.window === "5h")
        return "5h";
    if (bucket.window === "weekly")
        return "weekly";
    return bucket.label;
}
function renderPopoverContent(host, reply, model, onRefresh, refreshing) {
    host.replaceChildren();
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px";
    const titleWrap = document.createElement("div");
    titleWrap.style.cssText = "display:flex;align-items:center;gap:6px;font-weight:600;color:var(--dsw-alias-label-primary, inherit)";
    const icon = (0, styles_js_1.createMangoSvg)(13);
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
    const ordered = (0, quota_js_1.orderBucketsForModel)(reply.buckets, model);
    for (const bucket of ordered) {
        const tone = TONE_COLOR[(0, quota_js_1.remainingTone)(bucket.remainingPercent)];
        const pct = Math.max(0, Math.min(100, bucket.remainingPercent));
        const row = document.createElement("div");
        row.style.cssText = "display:grid;grid-template-columns:1fr auto;align-items:baseline;column-gap:12px;row-gap:3px;padding:3px 0";
        const label = document.createElement("span");
        label.style.cssText = "color:var(--dsw-alias-label-primary, inherit);font-weight:500;font-size:12px";
        label.textContent = bucket.label + (bucket.disabled ? " (paused)" : "");
        const val = document.createElement("span");
        val.style.cssText = `font-variant-numeric:tabular-nums;font-weight:600;font-size:12px;color:${tone}`;
        val.textContent = `${(0, quota_js_1.formatPercent)(pct)} left`;
        const bar = document.createElement("div");
        bar.setAttribute("role", "progressbar");
        bar.setAttribute("aria-valuemin", "0");
        bar.setAttribute("aria-valuemax", "100");
        bar.setAttribute("aria-valuenow", String(Math.round(pct)));
        bar.setAttribute("aria-label", `${bucket.label} ${(0, quota_js_1.formatPercent)(pct)} remaining`);
        bar.style.cssText = "grid-column:1 / -1;height:4px;border-radius:2px;background:var(--dsw-alias-border-l2, rgba(128,128,128,.22));overflow:hidden";
        const fill = document.createElement("div");
        fill.style.cssText = `height:100%;width:${pct}%;border-radius:2px;background:${tone}`;
        bar.append(fill);
        const reset = (0, quota_js_1.formatReset)(bucket.resetsAt);
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
function renderTooltipContent(host, reply, model) {
    host.replaceChildren();
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:flex-start;gap:6px";
    const icon = (0, styles_js_1.createMangoSvg)(12);
    icon.style.cssText = "flex:0 0 auto;margin-top:2px;color:var(--dsw-alias-label-secondary, rgba(128,128,128,.85))";
    const text = document.createElement("span");
    if (!reply.ok) {
        text.textContent = `Antigravity · quota unavailable`;
    }
    else {
        const binding = (0, quota_js_1.bindingBucketsForModel)(reply.buckets, model);
        const parts = binding.map((b) => `${shortWindowLabel(b)} ${(0, quota_js_1.formatPercent)(b.remainingPercent)} left`);
        text.textContent = parts.length > 0 ? `Antigravity · ${parts.join(" · ")}` : "Antigravity";
    }
    row.append(icon, text);
    host.append(row);
}
/**
 * Mounts Antigravity quota inside DSH's context-meter tooltip and popover when the active
 * session is on the `antigravity` provider, and tints the ring when a quota window runs low.
 */
function watchContextMeter(ctx) {
    let arc;
    let quotaReply;
    let lastFetch = 0;
    let disposed = false;
    let frameQueued = false;
    let refreshing = false;
    const portalPanel = () => {
        const trigger = arc?.closest("button");
        if (!trigger || trigger.getAttribute("aria-expanded") !== "true")
            return null;
        const label = trigger.getAttribute("aria-label");
        if (!label)
            return null;
        for (const panel of document.querySelectorAll('[role="dialog"]')) {
            if (panel.contains(trigger))
                continue;
            const own = panel.getAttribute("aria-label");
            if (own && own !== label && label.includes(own))
                return panel;
        }
        return null;
    };
    const isRingTip = (tip) => {
        if (isRingRoot(tip.parentElement))
            return true;
        const ring = arc?.closest("button");
        if (tip.parentElement !== document.body || !tip.hasAttribute("data-portal"))
            return false;
        if (ring?.matches(":hover, :focus-visible") !== true)
            return false;
        const box = tip.getBoundingClientRect();
        const r = ring.getBoundingClientRect();
        const near = 24;
        return box.left < r.right + near && box.right > r.left - near && box.top < r.bottom + near && box.bottom > r.top - near;
    };
    const refreshQuota = (fresh) => {
        if (disposed)
            return;
        if (fresh)
            refreshing = true;
        lastFetch = Date.now();
        void (0, quota_js_1.loadQuota)(fresh).then((reply) => {
            if (disposed)
                return;
            refreshing = false;
            quotaReply = reply;
            runPass();
        });
    };
    const attachPopover = (panel, model) => {
        let block = panel.querySelector(`:scope > [${MARK}]`);
        if (!block) {
            block = document.createElement("div");
            block.setAttribute(MARK, "popover");
            block.style.cssText =
                "border-bottom:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.22));margin-bottom:10px;padding-bottom:8px;font-size:13px;line-height:20px";
            panel.prepend(block);
        }
        if (!quotaReply) {
            block.textContent = "Loading Antigravity quota…";
            if (Date.now() - lastFetch > 5_000)
                refreshQuota(false);
            return;
        }
        renderPopoverContent(block, quotaReply, model, () => {
            refreshQuota(true);
            runPass();
        }, refreshing);
    };
    const attachTooltip = (tip, model) => {
        let block = tip.querySelector(`:scope > [${MARK}]`);
        if (!block) {
            block = document.createElement("div");
            block.setAttribute(MARK, "tooltip");
            block.style.cssText =
                "max-width:min(80vw,420px);white-space:normal;overflow-wrap:anywhere;padding-bottom:4px;margin-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.22))";
            tip.prepend(block);
        }
        if (!quotaReply) {
            block.textContent = "Antigravity · loading quota…";
            if (Date.now() - lastFetch > 5_000)
                refreshQuota(false);
            return;
        }
        renderTooltipContent(block, quotaReply, model);
    };
    const paintRingTint = (active, model) => {
        if (arc?.isConnected !== true)
            return;
        let stroke = "";
        if (active && quotaReply?.ok) {
            const binding = (0, quota_js_1.bindingBucketsForModel)(quotaReply.buckets, model);
            let minRemaining = Infinity;
            for (const b of binding) {
                if (!b.disabled && b.remainingPercent < minRemaining)
                    minRemaining = b.remainingPercent;
            }
            if (minRemaining <= 5)
                stroke = TONE_COLOR.err;
            else if (minRemaining <= 15)
                stroke = TONE_COLOR.warn;
        }
        if (stroke) {
            if (arc.style.stroke !== stroke)
                arc.style.stroke = stroke;
            arc.setAttribute(TINT_MARK, "1");
        }
        else if (arc.hasAttribute(TINT_MARK)) {
            arc.style.stroke = "";
            arc.removeAttribute(TINT_MARK);
        }
    };
    const cleanupForeign = () => {
        for (const el of document.querySelectorAll(`[${MARK}]`))
            el.remove();
        if (arc?.hasAttribute(TINT_MARK)) {
            arc.style.stroke = "";
            arc.removeAttribute(TINT_MARK);
        }
    };
    const runPass = () => {
        frameQueued = false;
        if (disposed)
            return;
        let state;
        try {
            state = activeAntigravityModel(ctx);
        }
        catch (error) {
            if (isInactiveContextError(error))
                dispose();
            return;
        }
        if (arc?.isConnected !== true) {
            arc = undefined;
            for (const btn of document.querySelectorAll('button[aria-haspopup="dialog"]')) {
                const host = btn.parentElement;
                const found = host && isRingRoot(host) ? host.querySelector(ARC_SEL) : null;
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
        for (const el of document.querySelectorAll('[role="dialog"]')) {
            if (isRingRoot(el.parentElement))
                attachPopover(el, state.model);
        }
        const portal = portalPanel();
        if (portal)
            attachPopover(portal, state.model);
        for (const tip of document.querySelectorAll('[role="tooltip"]')) {
            if (isRingTip(tip))
                attachTooltip(tip, state.model);
        }
        paintRingTint(true, state.model);
    };
    const schedule = () => {
        if (disposed || frameQueued)
            return;
        frameQueued = true;
        requestAnimationFrame(runPass);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    let offList;
    try {
        offList = ctx.sessions?.list?.subscribe?.(schedule);
    }
    catch (error) {
        if (isInactiveContextError(error)) {
            observer.disconnect();
            return () => { };
        }
    }
    const dispose = () => {
        if (disposed)
            return;
        disposed = true;
        observer.disconnect();
        try {
            offList?.();
        }
        catch { /* ignore on teardown */ }
        cleanupForeign();
    };
    runPass();
    return dispose;
}

  },
  "./index.js": function(require, exports, module) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
/** dsh-oh-my-gravity, browser half: Settings page + Antigravity quota in the context meter. */
const react_1 = require("react");
const Section_js_1 = require("./Section.js");
const styles_js_1 = require("./styles.js");
const context_meter_js_1 = require("./context-meter.js");
exports.inject = ["slots", "sessions", "modelDirectories"];
const LABEL = "Oh My Gravity";
/** DSH draws a gear for every settings page it has no glyph for, and the slot has no icon field. `settings.action`
 *  mounts whenever the dialog opens, so a renderless entry there swaps the gear in our row for the mark. */
function NavIcon() {
    (0, react_1.useEffect)(() => {
        const row = [...document.querySelectorAll('[role="dialog"][aria-modal="true"] nav button')]
            .find((button) => button.textContent?.trim() === LABEL);
        const gear = row?.querySelector("svg");
        if (!gear || gear.hasAttribute("data-omg-mark"))
            return;
        const svg = (0, styles_js_1.createMangoSvg)(16, gear.getAttribute("class") ?? "");
        svg.setAttribute("data-omg-mark", "");
        gear.replaceWith(svg);
    });
    return null;
}
function apply(ctx) {
    ctx.effect(() => (0, styles_js_1.installStyles)(), "dsh-oh-my-gravity: styles");
    ctx.effect(() => (0, context_meter_js_1.watchContextMeter)(ctx), "dsh-oh-my-gravity: context meter");
    ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "oh-my-gravity", order: 15, label: () => LABEL }, Section_js_1.Section));
    ctx.slots.inject("settings.action", () => ctx.slots.register({ name: "settings.action", id: "oh-my-gravity-nav-icon", order: 99, inject: () => ({}) }, NavIcon));
}

  },
  "./quota.js": function(require, exports, module) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROUTE = void 0;
exports.loadQuota = loadQuota;
exports.formatReset = formatReset;
exports.orderBucketsForModel = orderBucketsForModel;
exports.bindingBucketsForModel = bindingBucketsForModel;
exports.remainingTone = remainingTone;
exports.formatPercent = formatPercent;
exports.ROUTE = "/dsh-oh-my-gravity";
const CLIENT_CACHE_MS = 30_000;
let cached;
let inFlightNormal;
let inFlightFresh;
async function fetchQuota(fresh) {
    try {
        const response = await fetch(`${exports.ROUTE}/api/quota${fresh ? "?fresh=1" : ""}`, {
            credentials: "same-origin",
            cache: "no-store",
        });
        const body = (await response.json().catch(() => null));
        if (!body || typeof body !== "object" || typeof body.ok !== "boolean") {
            return { ok: false, error: `request failed (${response.status})` };
        }
        if (body.ok)
            cached = { at: Date.now(), reply: body };
        return body;
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
function loadQuota(fresh = false) {
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
function formatReset(resetsAt, now = Date.now()) {
    if (resetsAt === null)
        return "";
    const ms = resetsAt - now;
    if (ms <= 0)
        return "resets now";
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
function targetFamilyForModel(model) {
    if (!model || model === "default")
        return "gemini";
    if (/claude|gpt/i.test(model))
        return "third-party";
    return "gemini";
}
function orderBucketsForModel(buckets, model) {
    const family = targetFamilyForModel(model);
    const primary = [];
    const secondary = [];
    for (const bucket of buckets) {
        if (bucket.family === family)
            primary.push(bucket);
        else
            secondary.push(bucket);
    }
    return [...primary, ...secondary];
}
function bindingBucketsForModel(buckets, model) {
    const family = targetFamilyForModel(model);
    const matching = buckets.filter((b) => b.family === family);
    return matching.length > 0 ? matching : [...buckets];
}
function remainingTone(remainingPercent) {
    if (remainingPercent <= 10)
        return "err";
    if (remainingPercent <= 25)
        return "warn";
    return "ok";
}
function formatPercent(value) {
    const clamped = Math.max(0, Math.min(100, value));
    return `${Math.round(clamped)}%`;
}

  },
  "./Section.js": function(require, exports, module) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Section = Section;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const quota_js_1 = require("./quota.js");
const ROUTE = "/dsh-oh-my-gravity";
async function call(path, body) {
    const response = await fetch(`${ROUTE}${path}`, {
        credentials: "same-origin",
        cache: "no-store",
        ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const data = (await response.json().catch(() => null));
    if (!response.ok || !data)
        throw new Error(data?.error ?? `request failed (${response.status})`);
    return data;
}
function Switch(props) {
    return ((0, jsx_runtime_1.jsx)("input", { type: "checkbox", role: "switch", className: "omg-switch", "aria-label": props.label, checked: props.checked, disabled: props.disabled, onChange: (event) => props.onChange(event.currentTarget.checked) }));
}
const TONE_CLASS = { err: "omg-bad", warn: "omg-warn", ok: "omg-good" };
const TONE_FILL = {
    err: "var(--dsw-alias-state-error-primary, #dc2626)",
    warn: "var(--dsw-alias-state-warn-primary, #d9822b)",
    ok: "var(--dsw-alias-state-success-primary, #16a34a)",
};
function Section() {
    const [status, setStatus] = (0, react_1.useState)();
    const [quota, setQuota] = (0, react_1.useState)();
    const [error, setError] = (0, react_1.useState)();
    const [busy, setBusy] = (0, react_1.useState)(false);
    const [quotaBusy, setQuotaBusy] = (0, react_1.useState)(false);
    const refreshQuota = (0, react_1.useCallback)(async (fresh = false) => {
        setQuotaBusy(true);
        try {
            setQuota(await (0, quota_js_1.loadQuota)(fresh));
        }
        finally {
            setQuotaBusy(false);
        }
    }, []);
    const load = (0, react_1.useCallback)(async (fresh = false) => {
        setBusy(true);
        try {
            setStatus(await call(fresh ? "/api/status?fresh=1" : "/api/status"));
            setError(undefined);
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            setBusy(false);
        }
    }, []);
    (0, react_1.useEffect)(() => {
        void load();
        void refreshQuota(false);
    }, [load, refreshQuota]);
    const save = async (change) => {
        try {
            const settings = await call("/api/settings", change);
            setStatus((current) => current && { ...current, settings });
            setError(undefined);
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };
    if (!status) {
        return (0, jsx_runtime_1.jsx)("div", { className: "omg", children: error ? (0, jsx_runtime_1.jsx)("div", { className: "omg-bad", children: error }) : (0, jsx_runtime_1.jsx)("div", { className: "omg-dim", children: "Checking Antigravity\u2026" }) });
    }
    const hidden = new Set(status.settings.hiddenModels);
    return ((0, jsx_runtime_1.jsxs)("div", { className: "omg", children: [error ? (0, jsx_runtime_1.jsx)("div", { className: "omg-bad", role: "alert", children: error }) : null, (0, jsx_runtime_1.jsxs)("div", { className: "omg-card", children: [(0, jsx_runtime_1.jsx)("h3", { children: "Antigravity CLI" }), (0, jsx_runtime_1.jsxs)("div", { className: "omg-row", children: [(0, jsx_runtime_1.jsx)("span", { children: "Command" }), (0, jsx_runtime_1.jsx)("code", { children: status.command })] }), (0, jsx_runtime_1.jsxs)("div", { className: "omg-row", children: [(0, jsx_runtime_1.jsx)("span", { children: "Version" }), status.version ? (0, jsx_runtime_1.jsx)("code", { children: status.version }) : (0, jsx_runtime_1.jsxs)("span", { className: "omg-bad", children: ["not found: install agy or set ", (0, jsx_runtime_1.jsx)("code", { children: "command" }), " in cordis.patch.yml"] })] }), status.plan ? (0, jsx_runtime_1.jsxs)("div", { className: "omg-row", children: [(0, jsx_runtime_1.jsx)("span", { children: "Plan" }), (0, jsx_runtime_1.jsx)("span", { children: status.plan })] }) : null, (0, jsx_runtime_1.jsxs)("div", { className: "omg-row", children: [(0, jsx_runtime_1.jsx)("span", { children: "Sign-in" }), status.signedIn ? (0, jsx_runtime_1.jsx)("span", { className: "omg-good", children: "signed in" }) : (0, jsx_runtime_1.jsxs)("span", { className: "omg-bad", children: ["AGY did not answer; run ", (0, jsx_runtime_1.jsx)("code", { children: "agy" }), " once to sign in"] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "omg-row", children: [(0, jsx_runtime_1.jsx)("span", { className: "omg-dim", children: "Shown from the last check; \"Check again\" asks AGY now." }), (0, jsx_runtime_1.jsx)("button", { className: "omg-btn", disabled: busy, onClick: () => { void load(true); }, children: busy ? "Checking…" : "Check again" })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "omg-card", children: [(0, jsx_runtime_1.jsx)("h3", { children: "Plan quota" }), !quota ? ((0, jsx_runtime_1.jsx)("div", { className: "omg-dim", children: "Checking quota\u2026" })) : !quota.ok ? ((0, jsx_runtime_1.jsx)("div", { className: "omg-bad", children: quota.error })) : (quota.buckets.map((bucket) => {
                        const tone = (0, quota_js_1.remainingTone)(bucket.remainingPercent);
                        const pct = Math.max(0, Math.min(100, bucket.remainingPercent));
                        const reset = (0, quota_js_1.formatReset)(bucket.resetsAt);
                        return ((0, jsx_runtime_1.jsxs)("div", { className: "omg-quota-item", children: [(0, jsx_runtime_1.jsxs)("div", { className: "omg-quota-head", children: [(0, jsx_runtime_1.jsxs)("span", { children: [bucket.label, bucket.disabled ? (0, jsx_runtime_1.jsx)("span", { className: "omg-dim", children: " (paused)" }) : null] }), (0, jsx_runtime_1.jsxs)("span", { className: `omg-quota-val ${TONE_CLASS[tone]}`, children: [(0, quota_js_1.formatPercent)(pct), " left"] })] }), (0, jsx_runtime_1.jsx)("div", { className: "omg-quota-bar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(pct), "aria-label": `${bucket.label} ${(0, quota_js_1.formatPercent)(pct)} remaining`, children: (0, jsx_runtime_1.jsx)("div", { className: "omg-quota-fill", style: { width: `${pct}%`, background: TONE_FILL[tone] } }) }), reset ? (0, jsx_runtime_1.jsx)("div", { className: "omg-quota-meta", children: reset }) : null] }, bucket.id));
                    })), (0, jsx_runtime_1.jsxs)("div", { className: "omg-row", children: [(0, jsx_runtime_1.jsx)("span", { className: "omg-dim", children: quota?.ok ? `Updated ${new Date(quota.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Reads AGY's statusLine quota payload." }), (0, jsx_runtime_1.jsx)("button", { className: "omg-btn", disabled: quotaBusy, onClick: () => { void refreshQuota(true); }, children: quotaBusy ? "Refreshing…" : "Refresh quota" })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "omg-card", children: [(0, jsx_runtime_1.jsx)("h3", { children: "Models in the picker" }), status.models.length === 0 ? (0, jsx_runtime_1.jsx)("div", { className: "omg-dim", children: "AGY reported no models." }) : null, status.models.map((model) => {
                        const locked = status.lockedModels.includes(model.id);
                        return ((0, jsx_runtime_1.jsxs)("div", { className: "omg-row", children: [(0, jsx_runtime_1.jsxs)("span", { children: [model.name, " ", (0, jsx_runtime_1.jsx)("code", { className: "omg-dim", children: model.id }), locked ? (0, jsx_runtime_1.jsx)("span", { className: "omg-dim", children: " \u00B7 left out by the profile's models setting" }) : null] }), (0, jsx_runtime_1.jsx)(Switch, { label: `Show ${model.name}`, checked: !locked && !hidden.has(model.id), disabled: locked, onChange: (show) => { void save({ hiddenModels: show ? [...hidden].filter((id) => id !== model.id) : [...hidden, model.id] }); } })] }, model.id));
                    }), (0, jsx_runtime_1.jsx)("div", { className: "omg-dim", children: "Takes effect when the picker next loads. A session already on a hidden model keeps working. Reasoning effort comes from DSH's effort chooser, for models that have levels (Gemini 3.8 Flash)." })] }), (0, jsx_runtime_1.jsxs)("div", { className: "omg-card", children: [(0, jsx_runtime_1.jsx)("h3", { children: "DSH tools" }), (0, jsx_runtime_1.jsxs)("div", { className: "omg-row", children: [(0, jsx_runtime_1.jsx)("span", { children: "Let Antigravity use DSH's tools (subagents, jobs, skills\u2026)" }), (0, jsx_runtime_1.jsx)(Switch, { label: "DSH tools for Antigravity", checked: status.settings.dshTools, onChange: (on) => { void save({ dshTools: on }); } })] }), (0, jsx_runtime_1.jsx)("div", { className: "omg-dim", children: "Every call asks for approval through DSH's own approval setting, with its arguments shown. Applies to sessions Antigravity starts from now on." })] })] }));
}

  },
  "./styles.js": function(require, exports, module) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MANGO_PATH = void 0;
exports.createMangoSvg = createMangoSvg;
exports.installStyles = installStyles;
/** Antigravity's mark (the arch from the product's own favicon), drawn in the element's text colour. */
exports.MANGO_PATH = "M14.02 19.5C17.9 19.22 21.07 15.31 19.12 11.12C16.88 6.64 11.39 3.35 8.24 3.09C6.35 3.02 5.94 5.11 5.46 7.46C4.48 12.18 8.31 19.21 14.02 19.5ZM12.88 19.12C13.75 20.23 14.42 20.99 14.83 21.91C15.79 21.36 16.57 20.91 16.28 20.61C15.78 19.75 15.55 18.95 14.98 18.36ZM15.19 20.32C17.23 21.45 20.3 20.37 21.53 18.51C19.49 17.37 16.42 18.45 15.19 20.32Z";
function createMangoSvg(size = 16, className = "") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    if (className)
        svg.setAttribute("class", className);
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", exports.MANGO_PATH);
    path.setAttribute("fill", "currentColor");
    svg.appendChild(path);
    return svg;
}
const CSS = String.raw `
.omg { display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-primary, inherit); }
.omg-card { border: 1px solid var(--dsw-alias-border-l1, rgb(127 127 127 / .2)); border-radius: 10px; padding: 14px 16px; background: var(--dsw-alias-bg-layer-1, transparent); }
.omg-card h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
.omg-dim { color: var(--dsw-alias-label-secondary, rgb(127 127 127)); font-size: 12px; line-height: 1.5; }
.omg-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 0; border-top: 1px solid var(--dsw-alias-border-l1, rgb(127 127 127 / .15)); }
.omg-row:first-of-type { border-top: 0; }
.omg-row code { font-size: 12px; }
.omg-good { color: var(--dsw-alias-state-success-primary, #16a34a); }
.omg-warn { color: var(--dsw-alias-state-warn-primary, #d9822b); }
.omg-bad { color: var(--dsw-alias-state-error-primary, #dc2626); }
.omg-switch { appearance: none; width: 34px; height: 20px; border-radius: 999px; position: relative; cursor: pointer; flex: none; background: rgb(127 127 127 / .35); transition: background .15s; }
.omg-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s; }
.omg-switch:checked { background: var(--dsw-alias-brand-primary, #4f46e5); }
.omg-switch:checked::after { transform: translateX(14px); }
.omg-switch:disabled { opacity: .45; cursor: not-allowed; }
.omg-btn { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer; border: 1px solid var(--dsw-alias-border-l2, rgb(127 127 127 / .35)); background: transparent; color: inherit; }
.omg-quota-item { display: flex; flex-direction: column; gap: 5px; padding: 8px 0; border-top: 1px solid var(--dsw-alias-border-l1, rgb(127 127 127 / .15)); }
.omg-quota-item:first-of-type { border-top: 0; }
.omg-quota-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.omg-quota-val { font-variant-numeric: tabular-nums; font-weight: 600; font-size: 12px; }
.omg-quota-bar { height: 4px; border-radius: 2px; background: var(--dsw-alias-border-l1, rgb(127 127 127 / .2)); overflow: hidden; }
.omg-quota-fill { height: 100%; border-radius: 2px; transition: width .2s ease; }
.omg-quota-meta { color: var(--dsw-alias-label-secondary, rgb(127 127 127)); font-size: 11px; line-height: 1.4; }
`;
/** Adds the stylesheet once; the returned function removes it. */
function installStyles() {
    const style = document.createElement("style");
    style.dataset.omg = "";
    style.textContent = CSS;
    document.head.appendChild(style);
    return () => style.remove();
}

  }
};
var __cache = {};
function __dirnamePosix(id) {
  var i = id.lastIndexOf("/");
  return i <= 1 ? "." : id.slice(0, i);
}
function __resolve(fromId, spec) {
  if (!spec.startsWith(".")) return null;
  var joined = __dirnamePosix(fromId) + "/" + spec;
  var normalized = [];
  for (var part of joined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  var candidate = "./" + normalized.join("/");
  if (__modules[candidate]) return candidate;
  if (__modules[candidate + ".js"]) return candidate + ".js";
  return candidate;
}
function __load(id) {
  if (__cache[id]) return __cache[id].exports;
  var fn = __modules[id];
  if (!fn) throw new Error("dsh-oh-my-gravity client module not found: " + id);
  var mod = __cache[id] = { exports: {} };
  fn(function(spec) {
    var local = __resolve(id, spec);
    if (local !== null) return __load(local);
    return hostRequire(spec);
  }, mod.exports, mod);
  return mod.exports;
}
return __load("./index.js");
} });
