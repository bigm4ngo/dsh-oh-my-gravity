import { LlmAdapter, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgyConnection } from "./agy-connection.js";
import { accessModeOf, isAutoAllowedRead, MODE_FOR_ACCESS } from "./gravity-plan-gate.js";
const LEVELS = ["low", "medium", "high", "xhigh"];
/** Context windows AGY 1.5.13 reported (usage_update.size) per model family; used until a turn reports the real one. Unknown models get a small window so DSH compacts early rather than late. */
export function contextFallback(model) {
    if (model === "default" || model.startsWith("gemini"))
        return 1_048_576;
    if (model.startsWith("claude"))
        return 1_000_000;
    if (model.startsWith("gpt-oss"))
        return 131_072;
    return 128_000;
}
const LEVEL_NAME = { low: "Low", medium: "Medium", high: "High", xhigh: "XHigh" };
/** Models AGY ships at several levels (`x-low`, `x-high`): base id → the levels present, low to high. */
function levelGroups(ids) {
    const found = new Map();
    for (const id of ids) {
        const m = /^(.+)-(low|medium|high|xhigh)$/.exec(id);
        if (m)
            found.set(m[1], (found.get(m[1]) ?? new Set()).add(m[2]));
    }
    const groups = new Map();
    for (const [base, levels] of found)
        if (levels.size > 1)
            groups.set(base, LEVELS.filter((l) => levels.has(l)));
    return groups;
}
const defaultLevel = (levels) => (levels.includes("high") ? "high" : levels.at(-1));
function catalogOf(created) {
    const models = object(created?.models);
    const list = [];
    if (Array.isArray(models?.availableModels)) {
        for (const raw of models.availableModels) {
            const m = object(raw);
            if (typeof m?.modelId === "string" && m.modelId)
                list.push({ id: m.modelId, name: typeof m.name === "string" && m.name ? m.name : m.modelId });
        }
    }
    const modes = object(created?.modes);
    const offered = Array.isArray(modes?.availableModes) ? modes.availableModes.map((m) => object(m)?.id).filter((id) => typeof id === "string") : [];
    return {
        list,
        current: typeof models?.currentModelId === "string" ? models.currentModelId : undefined,
        plan: typeof object(object(object(created?._meta)?.antigravity)?.tier)?.name === "string" ? object(object(object(created?._meta)?.antigravity)?.tier)?.name : undefined,
        modes: offered,
        mode: typeof modes?.currentModeId === "string" ? modes.currentModeId : undefined,
    };
}
const MAX_REASON = 4000;
const COMMAND_KEYS = new Set(["CommandLine", "command", "BypassSandbox", "IsDaemon", "WaitMsBeforeAsync", "toolSummary", "Cwd", "cwd"]);
const FILE_KEYS = new Set(["Path", "path", "file_path", "filePath", "StartLine", "EndLine", "ByteOffset"]);
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
const cleanControl = (value) => value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
const isEmptyObject = (value) => {
    const obj = object(value);
    return !!obj && Object.keys(obj).length === 0;
};
function mergeToolMeta(call, prev) {
    const title = typeof call?.title === "string" && cleanControl(call.title) ? call.title : prev?.title;
    const kind = typeof call?.kind === "string" && cleanControl(call.kind) ? call.kind : prev?.kind;
    const keepPrevRaw = isEmptyObject(call?.rawInput) && prev?.rawInput !== undefined && !isEmptyObject(prev.rawInput);
    const rawInput = call?.rawInput !== undefined && !keepPrevRaw ? call.rawInput : prev?.rawInput;
    const locations = Array.isArray(call?.locations) && call.locations.length ? call.locations : prev?.locations;
    return {
        ...(title !== undefined ? { title } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(rawInput !== undefined ? { rawInput } : {}),
        ...(locations !== undefined ? { locations } : {}),
    };
}
function capReason(text, suffix = `… [truncated: ${text.length} chars total]`) {
    if (text.length <= MAX_REASON)
        return text;
    const keep = Math.max(0, MAX_REASON - suffix.length);
    return `${text.slice(0, keep)}${suffix}`;
}
/** Builds a human- and Auto-Review-readable explanation from permission/tool-call metadata. */
export function describePermission(toolName, call, prev) {
    const { title, kind, rawInput, locations } = mergeToolMeta(call, prev);
    const inputObj = object(rawInput);
    if (inputObj) {
        const rawCmd = typeof inputObj.CommandLine === "string"
            ? inputObj.CommandLine
            : typeof inputObj.command === "string"
                ? inputObj.command
                : undefined;
        if (rawCmd !== undefined && cleanControl(rawCmd).length > 0) {
            const tags = [];
            if (inputObj.BypassSandbox === true)
                tags.push("UNSANDBOXED, BypassSandbox: true");
            else if (inputObj.BypassSandbox === false)
                tags.push("sandboxed");
            if (inputObj.IsDaemon === true)
                tags.push("daemon");
            const rawCwd = typeof inputObj.Cwd === "string"
                ? inputObj.Cwd
                : typeof inputObj.cwd === "string"
                    ? inputObj.cwd
                    : undefined;
            const cwd = rawCwd ? cleanControl(rawCwd) : "";
            const summary = typeof inputObj.toolSummary === "string" ? cleanControl(inputObj.toolSummary) : "";
            const extraObj = {};
            for (const [k, v] of Object.entries(inputObj)) {
                if (!COMMAND_KEYS.has(k) && v !== undefined)
                    extraObj[k] = v;
            }
            const extra = Object.keys(extraObj).length ? ` ${cleanControl(JSON.stringify(extraObj) ?? "")}` : "";
            const prefix = `Antigravity wants to ${toolName}${tags.length ? ` [${tags.join(", ")}]` : ""}${cwd ? ` in ${cwd}` : ""}${summary ? ` (${summary})` : ""}: `;
            const cmd = cleanControl(rawCmd);
            const full = `${prefix}${cmd}${extra}`;
            if (full.length <= MAX_REASON)
                return full;
            const suffix = (prefix + cmd).length > MAX_REASON
                ? `… [COMMAND TRUNCATED: ${rawCmd.length} chars total]`
                : `… [truncated: ${full.length} chars total]`;
            return capReason(full, suffix);
        }
        const rawPath = typeof inputObj.Path === "string"
            ? inputObj.Path
            : typeof inputObj.path === "string"
                ? inputObj.path
                : typeof inputObj.file_path === "string"
                    ? inputObj.file_path
                    : typeof inputObj.filePath === "string"
                        ? inputObj.filePath
                        : undefined;
        const cleanedPath = rawPath ? cleanControl(rawPath) : "";
        if (cleanedPath) {
            const start = typeof inputObj.StartLine === "number" && Number.isFinite(inputObj.StartLine) ? inputObj.StartLine : undefined;
            const end = typeof inputObj.EndLine === "number" && Number.isFinite(inputObj.EndLine) ? inputObj.EndLine : undefined;
            const rangeNote = start !== undefined && end !== undefined
                ? ` (lines ${start}-${end})`
                : start !== undefined
                    ? ` (from line ${start})`
                    : end !== undefined
                        ? ` (to line ${end})`
                        : "";
            const extraObj = {};
            for (const [k, v] of Object.entries(inputObj)) {
                if (!FILE_KEYS.has(k) && v !== undefined)
                    extraObj[k] = v;
            }
            const extraNote = Object.keys(extraObj).length ? ` ${cleanControl(JSON.stringify(extraObj) ?? "")}` : "";
            return capReason(`Antigravity wants to ${toolName} ${cleanedPath}${rangeNote}${extraNote}`);
        }
    }
    const hasNonEmptyRaw = rawInput !== undefined && rawInput !== null && (inputObj ? Object.keys(inputObj).length > 0
        : Array.isArray(rawInput) ? rawInput.length > 0
            : typeof rawInput === "string" ? cleanControl(rawInput).length > 0
                : true);
    if (hasNonEmptyRaw) {
        const serialized = typeof rawInput === "string" ? rawInput : (JSON.stringify(rawInput) ?? "");
        const shown = cleanControl(serialized);
        if (shown) {
            const cleanedTitle = title ? cleanControl(title) : "";
            const titleNote = cleanedTitle && cleanedTitle !== toolName ? ` (${cleanedTitle})` : "";
            return capReason(`Antigravity wants to run ${toolName}${titleNote}: ${shown}`);
        }
    }
    const cleanedTitle = title ? cleanControl(title) : "";
    const distinctTitle = cleanedTitle && cleanedTitle !== toolName ? cleanedTitle : "";
    const locPaths = [];
    for (const loc of locations ?? []) {
        const raw = typeof loc === "string"
            ? loc
            : typeof object(loc)?.path === "string"
                ? object(loc).path
                : undefined;
        const p = raw ? cleanControl(raw) : "";
        if (p && !locPaths.includes(p) && (!distinctTitle || !distinctTitle.includes(p)))
            locPaths.push(p);
    }
    const parts = [distinctTitle, ...locPaths].filter(Boolean);
    const cleanedKind = kind ? cleanControl(kind) : "";
    if (parts.length) {
        return capReason(`Antigravity wants to run ${toolName}${cleanedKind ? ` (${cleanedKind})` : ""}: ${parts.join(" — ")}`);
    }
    return `Antigravity requested permission for ${toolName}${cleanedKind ? ` (${cleanedKind})` : ""}.`;
}
const PATH_KEYS = ["Path", "path", "file_path", "filePath", "DirectoryPath", "SearchPath"];
function extractPaths(meta) {
    const seen = new Set();
    const add = (value) => {
        if (typeof value !== "string")
            return;
        const cleaned = cleanControl(value);
        if (cleaned)
            seen.add(cleaned);
    };
    const inputObj = object(meta.rawInput);
    if (inputObj) {
        for (const key of PATH_KEYS)
            add(inputObj[key]);
    }
    for (const loc of meta.locations ?? []) {
        if (typeof loc === "string")
            add(loc);
        else
            add(object(loc)?.path);
    }
    return [...seen];
}
async function decidePermission(params, sessionId, signal, approve, rows, refused, log, toolMeta, bridge, access, fullAccess = false) {
    const call = object(params.toolCall);
    const callId = call?.toolCallId;
    const label = call?.name ?? call?.title;
    if (signal.aborted || typeof callId !== "string" || !callId || callId.length > 256 ||
        typeof label !== "string" || !Array.isArray(params.options))
        return;
    const toolName = cleanControl(label).slice(0, 160);
    if (!toolName)
        return;
    const options = params.options.map(object);
    const ids = new Set();
    for (const option of options) {
        const id = option?.optionId;
        if (typeof id !== "string" || !id || ids.has(id))
            return;
        ids.add(id);
    }
    const allow = options.filter((option) => option?.kind === "allow_once");
    const reject = options.filter((option) => option?.kind === "reject_once");
    if (allow.length !== 1 || reject.length > 1)
        return;
    const dshCallId = rows?.callId(callId) ?? callId;
    const kind = typeof call?.kind === "string" ? call.kind : undefined;
    const effectiveKind = kind ?? toolMeta?.get(callId)?.kind;
    if (fullAccess) {
        log?.(`permission "${toolName}" (${effectiveKind ?? "?"}) → auto-allowed (danger-full-access)`);
        return { outcome: { outcome: "selected", optionId: allow[0].optionId } };
    }
    const mcpTool = (effectiveKind === undefined || effectiveKind === "other") && toolName.startsWith("mcp_dsh_")
        ? toolName.slice("mcp_dsh_".length)
        : undefined;
    if (mcpTool && bridge?.ownsTool?.(mcpTool)) {
        log?.(`permission "${toolName}" (${effectiveKind ?? "?"}) → deferred to DSH tool bridge`);
        return { outcome: { outcome: "selected", optionId: allow[0].optionId } };
    }
    const merged = mergeToolMeta(call, toolMeta?.get(callId));
    const paths = extractPaths(merged);
    if (isAutoAllowedRead(access, toolName, effectiveKind, paths)) {
        log?.(`permission "${toolName}" (read) → auto-allowed (${access} read)`);
        return { outcome: { outcome: "selected", optionId: allow[0].optionId } };
    }
    const reason = describePermission(toolName, call, toolMeta?.get(callId));
    const response = await approve({ sessionId, callId: dshCallId, toolName, reason, signal });
    if (signal.aborted)
        return;
    log?.(`permission "${toolName}" (${kind ?? "?"}) → DSH ${response}`);
    if (response !== "allowed-once")
        refused?.(toolName);
    const optionId = (response === "allowed-once" ? allow[0] : response === "rejected" ? reject[0] : undefined)?.optionId;
    if (typeof optionId !== "string")
        return;
    return { outcome: { outcome: "selected", optionId } };
}
const count = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
function tokenUsage(value) {
    const u = object(value);
    const input = count(u?.inputTokens);
    const outputTokens = count(u?.outputTokens);
    const cacheReadTokens = count(u?.cachedReadTokens);
    const cacheWriteTokens = count(u?.cachedWriteTokens);
    if (input === undefined || outputTokens === undefined)
        return;
    const inputTokens = input - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0);
    if (inputTokens < 0)
        return;
    const totalTokens = count(u?.totalTokens);
    const reasoningTokens = count(u?.thoughtTokens);
    return {
        inputTokens,
        outputTokens,
        ...(totalTokens === input + outputTokens ? { totalTokens } : {}),
        ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
        ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
        ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    };
}
export const GRAVITY_PROVIDER = "antigravity";
/** ACP-backed provider. AGY owns execution; only explicit, one-time host approvals are relayed. */
export class GravityAdapter extends LlmAdapter {
    launch;
    cwdFor;
    approve;
    resume;
    toolRows;
    mcp;
    sessions = new Map();
    living = new Set();
    disposed = false;
    /** DSH's access mode as of each keyed session's latest turn. */
    access = new Map();
    lastLogged = new Map();
    /** Context windows AGY reported during turns, by model id (and by its level-free id). shortcut: not kept across restarts; the family table covers that. */
    contexts = new Map();
    catalog;
    constructor(launch, cwdFor, approve, resume, toolRows, mcp) {
        super();
        this.launch = launch;
        this.cwdFor = cwdFor;
        this.approve = approve;
        this.resume = resume;
        this.toolRows = toolRows;
        this.mcp = mcp;
    }
    providerInfo(provider) {
        return { id: provider, name: "Oh My Gravity" };
    }
    probing;
    reaper;
    probeConn;
    diskRead = false;
    /** One throwaway AGY session, only to read its model list. */
    async probeOnce() {
        const cwd = await mkdtemp(join(tmpdir(), "gravity-models-"));
        const probe = this.probeConn = new AgyConnection({ ...this.launch, cwd, timeoutMs: 15_000 });
        let probeId;
        try {
            await probe.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
            const created = object(await probe.request("session/new", { cwd, mcpServers: [] }));
            probeId = created?.sessionId;
            const { list, plan } = catalogOf(created);
            return { list, ...(plan ? { plan } : {}) };
        }
        finally {
            await probe.close();
            if (this.probeConn === probe)
                this.probeConn = undefined;
            this.forgetEmpty(probeId);
            await rm(cwd, { recursive: true, force: true });
        }
    }
    /**
     * AGY keeps every session/new as a conversation file (~400 KB) in its history, and ACP has no way to delete one. A probe session is
     * never prompted, so its conversation is empty and ours alone: remove it, by an id that is checked to be a plain id, never a path.
     */
    forgetEmpty(id) {
        if (typeof id !== "string" || !/^[A-Za-z0-9-]+$/.test(id))
            return;
        const dir = this.launch.conversationsDir ?? join(homedir(), ".gemini", "antigravity-cli", "conversations");
        for (const suffix of [".db", ".db-wal", ".db-shm"]) {
            try {
                rmSync(join(dir, `${id}${suffix}`), { force: true });
            }
            catch { /* AGY's store is not ours to insist on */ }
        }
    }
    /** Stops a session's AGY process; its conversation stays and resumes by session/load on the next turn. */
    evict(key, session) {
        if (this.sessions.get(key) === session)
            this.sessions.delete(key);
        session.retired = true;
        void this.release(session);
    }
    reap() {
        const idleMs = this.launch.idleMs ?? 30 * 60_000;
        for (const [key, session] of this.sessions)
            if (!session.busy && Date.now() - session.lastUsed >= idleMs)
                this.evict(key, session);
    }
    /** Makes room for one more process: the longest-idle quiet sessions go first. */
    makeRoom() {
        const max = this.launch.maxProcesses ?? 4;
        while (this.processCount() >= max) {
            const quiet = [...this.sessions].filter(([, s]) => !s.busy).sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0];
            if (!quiet)
                return;
            this.evict(quiet[0], quiet[1]);
        }
    }
    /** How many AGY processes serve sessions right now. */
    processCount() {
        return [...this.living].filter((s) => !s.retired).length;
    }
    /** One refresh at a time, however many callers ask; a failed start is tried once more. Never throws. */
    refresh() {
        return this.probing ??= (async () => {
            for (let attempt = 1; attempt <= 2 && !this.disposed; attempt++) {
                try {
                    const { list, plan } = await this.probeOnce();
                    this.catalog = { at: Date.now(), list, ...(plan ? { plan } : {}) };
                    const file = this.launch.catalogFile;
                    if (file && list.length) {
                        try {
                            mkdirSync(dirname(file), { recursive: true });
                            writeFileSync(`${file}.tmp`, JSON.stringify({ list, ...(plan ? { plan } : {}) }), { mode: 0o600 });
                            renameSync(`${file}.tmp`, file);
                        }
                        catch { /* the list still works without its copy on disk */ }
                    }
                    return true;
                }
                catch (error) {
                    this.launch.log?.(`model list probe failed (attempt ${attempt}): ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            return false;
        })().finally(() => { this.probing = undefined; });
    }
    /** The last good list from disk, treated as stale so it is refreshed at once. */
    readDisk() {
        if (this.diskRead || this.catalog || !this.launch.catalogFile)
            return;
        this.diskRead = true;
        try {
            const raw = object(JSON.parse(readFileSync(this.launch.catalogFile, "utf8")));
            const list = Array.isArray(raw?.list) ? raw.list.map(object).filter((m) => !!m && typeof m.id === "string" && typeof m.name === "string") : [];
            if (list.length)
                this.catalog = { at: 0, list: list, ...(typeof raw?.plan === "string" ? { plan: raw.plan } : {}) };
        }
        catch { /* no usable copy: the first request asks AGY */ }
    }
    /**
     * AGY's model list, one entry per model (levels folded). A list we already hold is answered at once, and when stale refreshed
     * behind the caller, so the picker never waits on a cold AGY start; only the very first request, or `force`, waits.
     * `answered` says whether AGY itself replied just now. The list is empty when AGY has never answered.
     */
    async shownModels(force = false) {
        this.readDisk();
        let answered = this.catalog !== undefined;
        if (!this.disposed) {
            if (force || !this.catalog)
                answered = await this.refresh();
            else if (Date.now() - this.catalog.at >= (this.launch.catalogTtlMs ?? 600_000))
                void this.refresh();
        }
        // A model AGY ships at several levels is one entry; the level comes from DSH's effort chooser.
        const raw = this.catalog?.list ?? [];
        const groups = levelGroups(raw.map((m) => m.id));
        const models = [];
        for (const m of raw) {
            const base = /^(.+)-(?:low|medium|high|xhigh)$/.exec(m.id)?.[1];
            if (base && groups.has(base)) {
                if (!models.some((x) => x.id === base))
                    models.push({ id: base, name: m.name.replace(/\s*\((?:low|medium|high|xhigh)\)\s*$/i, "") });
            }
            else
                models.push(m);
        }
        return { models, answered };
    }
    async listModels(provider) {
        const only = this.launch.models;
        const hidden = this.launch.hidden?.() ?? [];
        return [{ provider, id: "default", name: "Antigravity CLI default" },
            ...(await this.shownModels()).models
                .filter((m) => (!only?.length || only.includes(m.id)) && !hidden.includes(m.id))
                .map((m) => ({ provider, ...m }))];
    }
    /**
     * For the Settings page, before any hiding. `fresh` asks AGY anew (which only answers a session request when signed in);
     * without it the page opens from the list already held, which says nothing new about sign-in but takes no AGY start.
     */
    async catalogStatus({ fresh }) {
        const { models, answered } = await this.shownModels(fresh);
        return { signedIn: answered, models, ...(this.catalog?.plan ? { plan: this.catalog.plan } : {}) };
    }
    async resolveModel(provider, model) {
        const name = (await this.shownModels()).models.find((m) => m.id === model)?.name ?? model;
        const levels = levelGroups((this.catalog?.list ?? []).map((m) => m.id)).get(model);
        return {
            provider, id: model, name,
            context: { contextWindow: this.contexts.get(model) ?? contextFallback(model) },
            ...(levels
                ? { reasoning: {
                        efforts: levels.map((id) => ({ id: ReasoningEffortId(id), name: LEVEL_NAME[id] ?? id })),
                        defaultEffort: ReasoningEffortId(defaultLevel(levels)),
                    } }
                : {}),
        };
    }
    open(cwd, fullAccess = false) {
        const args = fullAccess && this.launch.fullAccessArgs ? this.launch.fullAccessArgs : this.launch.args;
        const connection = new AgyConnection({ ...this.launch, args, cwd, timeoutMs: 15_000 }, (method, params) => {
            if (!session.id || params.sessionId !== session.id)
                return;
            if (method === "session/update")
                session.update?.(params.update);
            if (method === "session/request_permission")
                return session.permission?.(params);
        });
        const session = { connection, cwd, fullAccess, busy: false, lastUsed: Date.now() };
        this.living.add(session);
        return session;
    }
    async release(session) {
        session.revokeMcp?.();
        session.mcpBridge = undefined;
        try {
            await session.connection.close();
        }
        finally {
            this.living.delete(session);
        }
    }
    /** DSH's access mode as of this session's latest turn, for the tool bridge. */
    accessOf(sessionId) {
        return this.access.get(sessionId);
    }
    async close() {
        this.disposed = true;
        void this.probeConn?.close();
        if (this.reaper)
            clearInterval(this.reaper);
        this.sessions.clear();
        await Promise.all([...this.living].map((session) => this.release(session)));
    }
    async *stream(options) {
        if (this.disposed)
            throw new Error("Oh My Gravity adapter is closed");
        const began = Date.now();
        let outcome = "error";
        const label = `${options.purpose ?? "turn"} model=${options.model}`;
        this.launch.log?.(`stream ${label} started`);
        const cwd = this.cwdFor(options.sessionId);
        if (!cwd)
            throw new Error("Oh My Gravity requires a DSH workspace directory");
        const key = options.purpose ? undefined : options.sessionId;
        const access = accessModeOf(options.messages);
        const wantFullAccess = !!key && access === "danger-full-access" && !!this.launch.fullAccessArgs;
        let session = key ? this.sessions.get(key) : undefined;
        if (session?.busy)
            throw new Error("An Antigravity turn is already running in this session");
        if (session && (session.cwd !== cwd || session.fullAccess !== wantFullAccess || session.connection.closed)) {
            session.busy = true;
            session.retired = true;
            try {
                await this.release(session);
            }
            finally {
                if (key && this.sessions.get(key) === session)
                    this.sessions.delete(key);
            }
            session = undefined;
        }
        const recent = options.messages.slice(options.messages.findLastIndex((m) => m.role === "assistant") + 1);
        const textOf = (messages) => messages.flatMap((message) => message.content.flatMap((block) => block.type === "text" && block.text.trim()
            ? [message.role === "user" ? block.text : `${message.role}: ${block.text}`]
            : []));
        // A live or reloaded AGY conversation already holds the history; a fresh one needs all of it.
        const recentParts = textOf(recent);
        const fullParts = textOf(options.messages);
        if (options.system?.trim())
            fullParts.unshift(`system: ${options.system}`);
        if (!(session?.id ? recentParts : fullParts).length)
            throw new Error("Oh My Gravity requires a text prompt");
        options.signal?.throwIfAborted();
        if (!session) {
            this.makeRoom();
            session = this.open(cwd, wantFullAccess);
            if (!this.reaper) {
                this.reaper = setInterval(() => this.reap(), this.launch.reapEveryMs ?? 60_000);
                this.reaper.unref();
            }
        }
        if (key)
            this.sessions.set(key, session);
        session.busy = true;
        const approvalLifetime = new AbortController();
        const conn = session.connection;
        let abortDeadline;
        const abort = () => {
            approvalLifetime.abort();
            if (!session.id)
                void conn.close();
            else {
                conn.notify("session/cancel", { sessionId: session.id });
                abortDeadline ??= setTimeout(() => { void conn.close(); }, 3000);
            }
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        let completed = false;
        let refusedTool;
        let spoke = false;
        let rows;
        try {
            let resumed = !!session.id;
            if (!session.id) {
                const init = object(await conn.request("initialize", { protocolVersion: 1, clientCapabilities: {} }));
                if (init?.protocolVersion !== 1)
                    throw new Error("Antigravity did not negotiate ACP version 1");
                const grant = key ? await this.mcp?.(key) : undefined;
                session.revokeMcp = grant?.revoke;
                session.mcpBridge = grant;
                const mcpServers = grant ? [grant.config] : [];
                const saved = key ? this.resume?.get(key) : undefined;
                let created;
                if (saved?.cwd === cwd) {
                    try {
                        // Replayed history arrives as updates for this id; no turn is listening yet, so it is dropped.
                        session.id = saved.agyId;
                        created = object(await conn.request("session/load", { sessionId: saved.agyId, cwd, mcpServers }));
                        resumed = true;
                    }
                    catch (error) {
                        session.id = undefined;
                        if (key)
                            this.resume?.delete(key);
                        if (conn.closed)
                            throw error;
                    }
                }
                if (!resumed) {
                    created = object(await conn.request("session/new", { cwd, mcpServers }));
                    if (typeof created?.sessionId !== "string" || !created.sessionId)
                        throw new Error("Antigravity did not return a session ID");
                    session.id = created.sessionId;
                }
                if (key && session.id)
                    this.resume?.set(key, session.id, cwd);
                const { list, current, modes, mode } = catalogOf(created);
                session.modes = new Set(modes);
                session.defaultMode = session.mode = mode;
                session.models = new Set(list.map((m) => m.id));
                session.defaultModel = session.model = current;
            }
            // DSH's access mode decides how much AGY may do on its own; with none stated, AGY's own default.
            if (key)
                this.access.set(key, access);
            const wantedMode = session.fullAccess ? undefined : ((access && MODE_FOR_ACCESS[access]) || session.defaultMode);
            // Only changes are logged, so the journal shows what DSH told AGY without a line per turn.
            const seen = session.fullAccess ? `${access}:full` : (access ?? "none");
            if (key && this.lastLogged.get(key) !== `${seen}`) {
                this.lastLogged.set(key, seen);
                this.launch.log?.(session.fullAccess
                    ? `session …${key.slice(-8)}: DSH access ${access} → AGY --dangerously-skip-permissions`
                    : access
                        ? `session …${key.slice(-8)}: DSH access ${access} → AGY mode ${wantedMode ?? "(AGY default)"}`
                        : `session …${key.slice(-8)}: no DSH access mode in the request; AGY stays on its default mode`);
            }
            if (!session.fullAccess && wantedMode && wantedMode !== session.mode) {
                if (!session.modes?.has(wantedMode))
                    throw new Error(`Antigravity does not offer mode ${wantedMode}, which DSH's ${access ?? "default"} access needs`);
                await conn.request("session/set_mode", { sessionId: session.id, modeId: wantedMode });
                session.mode = wantedMode;
            }
            let wanted = options.model === "default" ? session.defaultModel : options.model;
            // The effort chooser picks among the levels AGY ships; AGY's own default level when none is chosen.
            const levels = wanted ? levelGroups(session.models ?? []).get(wanted) : undefined;
            if (wanted && levels)
                wanted = `${wanted}-${options.reasoningEffort ?? defaultLevel(levels)}`;
            if (wanted && wanted !== session.model) {
                if (!session.models?.has(wanted))
                    throw new Error(`Antigravity does not offer model ${wanted}`);
                await conn.request("session/set_model", { sessionId: session.id, modelId: wanted });
                session.model = wanted;
            }
            else if (!wanted && options.model !== "default" && !session.models?.has(options.model)) {
                throw new Error(`Antigravity does not offer model ${options.model}`);
            }
            options.signal?.throwIfAborted();
            rows = key ? this.toolRows?.(key, options.model) : undefined;
            const toolMeta = new Map();
            const chunks = [];
            let wake;
            let index = 0;
            let block;
            let result;
            let failed;
            let finished = false;
            let bytes = 0;
            const endBlock = () => {
                if (block)
                    chunks.push({ type: "block-end", index: index++, block });
                block = undefined;
            };
            session.update = (raw) => {
                const update = object(raw);
                const kind = update?.sessionUpdate;
                if (kind === "usage_update") {
                    const size = update?.size;
                    if (typeof size === "number" && Number.isSafeInteger(size) && size > 0 && session.model) {
                        this.contexts.set(session.model, size);
                        this.contexts.set(session.model.replace(/-(?:low|medium|high|xhigh)$/, ""), size);
                        if (options.model === "default")
                            this.contexts.set("default", size);
                    }
                    return;
                }
                if (kind === "tool_call" || kind === "tool_call_update") {
                    rows?.update(update);
                    const id = update?.toolCallId;
                    if (typeof id === "string" && id && id.length <= 256) {
                        if (update?.status === "completed" || update?.status === "failed") {
                            toolMeta.delete(id);
                        }
                        else {
                            const prev = toolMeta.get(id);
                            if (prev || toolMeta.size < 256)
                                toolMeta.set(id, mergeToolMeta(update, prev));
                        }
                    }
                    return;
                }
                const type = kind === "agent_message_chunk" ? "text" : kind === "agent_thought_chunk" ? "reasoning" : undefined;
                const content = object(update?.content);
                if (!type || content?.type !== "text" || typeof content.text !== "string" || !content.text)
                    return;
                if (type === "text")
                    spoke = true;
                bytes += Buffer.byteLength(content.text);
                if (bytes > 8 * 1024 * 1024 || chunks.length > 4096) {
                    failed = { error: new Error("Antigravity exceeded the turn output limit") };
                    void conn.close();
                    return;
                }
                if (block?.type !== type) {
                    endBlock();
                    block = { type, text: "" };
                    chunks.push({ type: "block-start", index, blockType: type });
                }
                block.text += content.text;
                chunks.push({ type: type === "text" ? "text-delta" : "reasoning-delta", index, text: content.text });
                wake?.();
            };
            const approval = this.approve;
            if (key && approval) {
                const fullAccess = session.fullAccess;
                session.permission = (params) => decidePermission(params, key, approvalLifetime.signal, approval, rows, (tool) => { refusedTool ??= tool; }, this.launch.log, toolMeta, session.mcpBridge, access, fullAccess);
            }
            void conn.request("session/prompt", {
                sessionId: session.id,
                prompt: [{ type: "text", text: (resumed ? recentParts : fullParts).join("\n\n") }],
            }, 15 * 60_000).then((reply) => {
                result = object(reply);
            }, (error) => {
                failed ??= { error };
            }).finally(() => {
                approvalLifetime.abort();
                session.permission = undefined;
                endBlock();
                finished = true;
                wake?.();
            });
            while (!finished || chunks.length) {
                if (chunks.length)
                    yield chunks.shift();
                else
                    await new Promise((resolve) => { wake = resolve; });
            }
            rows?.finish();
            if (failed)
                throw failed.error;
            if (refusedTool && !spoke) {
                const text = `Antigravity stopped because permission for ${refusedTool} was not granted.`;
                yield { type: "block-start", index, blockType: "text" };
                yield { type: "text-delta", index, text };
                yield { type: "block-end", index, block: { type: "text", text } };
            }
            const usage = tokenUsage(result?.usage);
            if (usage)
                yield { type: "usage", usage };
            const stop = result?.stopReason;
            completed = true;
            outcome = stop === "cancelled" || options.signal?.aborted ? "cancelled" : typeof stop === "string" ? stop : "?";
            if (stop === "cancelled" || options.signal?.aborted) {
                yield { type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED", message: "Antigravity turn cancelled" } } };
            }
            else if (stop === "max_tokens")
                yield { type: "finish", reason: { kind: "max-tokens" } };
            else if (stop === "end_turn" || stop === "stop_sequence")
                yield { type: "finish", reason: { kind: "stop" } };
            else {
                completed = false;
                throw new Error("Antigravity did not return a supported stop reason");
            }
        }
        finally {
            this.launch.log?.(`stream ${label} finished in ${Date.now() - began}ms (${outcome})`);
            options.signal?.removeEventListener("abort", abort);
            approvalLifetime.abort();
            session.permission = undefined;
            clearTimeout(abortDeadline);
            session.update = undefined;
            try {
                rows?.finish();
            }
            finally {
                session.busy = false;
                session.lastUsed = Date.now();
                if (!key || !completed || conn.closed) {
                    if (key && this.sessions.get(key) === session)
                        this.sessions.delete(key);
                    await this.release(session);
                }
            }
        }
    }
}
//# sourceMappingURL=gravity-adapter.js.map