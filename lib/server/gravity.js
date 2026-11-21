import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { GRAVITY_PROVIDER, GravityAdapter } from "./gravity-adapter.js";
import { gravityToolRows } from "./gravity-tool-rows.js";
import { fileResumeMap } from "./gravity-store.js";
import { fileSettings } from "./gravity-settings.js";
import { nodeHandler, ROUTE, throttled } from "./gravity-settings-routes.js";
import { startToolBridge } from "./gravity-mcp.js";
import { readOnlyRefusal } from "./gravity-plan-gate.js";
import { agyEnv } from "./gravity-env.js";
export const name = "dsh-oh-my-gravity";
export const inject = ["llm", "sessions", "connection"];
/** Longest argument text an approval prompt may carry; larger calls are refused rather than truncated. */
const MAX_SHOWN_ARGS = 4000;
export const Config = z.object({
    command: z.string().default("agy").description("Path to your signed-in Antigravity CLI."),
    idleMinutes: z.number().min(1).default(30).description("Stop a session's Antigravity process (about 240 MB) after this many idle minutes; it resumes on the next message."),
    maxProcesses: z.number().min(1).default(4).description("Most Antigravity processes kept alive at once; the longest idle is stopped first."),
    models: z.array(z.string()).default([]).description("Model ids to offer in the picker, e.g. gemini-3.8-flash. Empty offers every model AGY reports."),
});
// Cordis constructs callbacks with a prototype; a plain arrow preserves the returned disposer.
export const apply = (ctx, config) => {
    const env = agyEnv(process.env, join(homedir(), ".local", "bin"), delimiter);
    // Started on the first turn that can use it, so a profile without DSH tools never opens a port.
    let bridge;
    const toolBridge = () => bridge ??= (async () => {
        const tools = ctx.get?.("tools");
        return tools && startToolBridge(tools, (id) => ctx.get?.("agents")?.get(id), async (id, tool, args, signal) => {
            const agent = ctx.get?.("agents")?.get(id);
            const approval = ctx.get?.("approval");
            if (!agent?.session || agent.session !== ctx.sessions.get(id) || !approval || signal.aborted)
                return "unavailable";
            // The person approves exactly what runs: arguments are shown whole, and a call too big to show is refused, never cut.
            const shown = JSON.stringify(args) ?? "";
            if (shown.length > MAX_SHOWN_ARGS)
                return "rejected";
            return approval.request({ agent, callId: randomUUID(), toolName: `mcp_dsh_${tool}`, reason: `Antigravity wants to run the DSH tool ${tool} with arguments ${shown}`, signal });
        }, (id, tool) => readOnlyRefusal(adapter.accessOf(id), tool));
    })().catch(() => undefined);
    const settings = fileSettings();
    const adapter = new GravityAdapter({ command: config.command, args: ["acp", "--sandbox"], env, models: config.models, idleMs: config.idleMinutes * 60_000, maxProcesses: config.maxProcesses, hidden: () => settings.get().hiddenModels,
        catalogFile: join(process.env.DSH_GRAVITY_STATE_DIR || join(homedir(), ".local", "state", "dsh-oh-my-gravity"), "catalog.json"),
        log: (message) => console.warn(`[dsh-oh-my-gravity] ${message}`) }, (id) => {
        const cwd = id && ctx.sessions.get(id)?.header.cwd;
        return cwd && isAbsolute(cwd) ? cwd : undefined;
    }, async ({ sessionId, callId, toolName, signal }) => {
        const agent = ctx.get?.("agents")?.get(sessionId);
        const approval = ctx.get?.("approval");
        if (!agent?.session || agent.session !== ctx.sessions.get(sessionId) || !approval || signal.aborted)
            return "unavailable";
        return approval.request({ agent, callId, toolName, signal });
    }, fileResumeMap(), (id, model) => {
        const session = ctx.sessions.get(id);
        return session && gravityToolRows(session, GRAVITY_PROVIDER, model);
    }, async (id) => (settings.get().dshTools ? (await toolBridge())?.issue(id) : undefined));
    ctx.llm.registerConfigurableProviders([{
            provider: GRAVITY_PROVIDER,
            displayName: "Oh My Gravity",
            settingsNs: `llm-${GRAVITY_PROVIDER}`,
            settingsPath: [],
        }]);
    ctx.llm.registerAdapter([GRAVITY_PROVIDER], adapter);
    // `agy --version` is asked once and remembered; "Check again" asks anew.
    let versionRead;
    const readVersion = (fresh) => (!fresh && versionRead) || (versionRead = new Promise((resolve) => execFile(config.command, ["--version"], { env, timeout: 5000 }, (error, out) => resolve(error ? undefined : out.trim() || undefined))));
    void readVersion(false);
    const check = async (fresh) => {
        const [version, seen] = await Promise.all([readVersion(fresh), adapter.catalogStatus({ fresh })]);
        return { command: config.command, ...(version ? { version } : {}), signedIn: seen.signedIn, ...(seen.plan ? { plan: seen.plan } : {}), models: seen.models, lockedModels: config.models.length ? seen.models.map((m) => m.id).filter((id) => !config.models.includes(id)) : [] };
    };
    // Opening the page reads what is already known and starts nothing; the forced check starts AGY, so one at a time, reused for 5 seconds.
    const forced = throttled(() => check(true), 5000);
    const status = (fresh) => (fresh ? forced() : check(false));
    // The Settings page's API; a composition without a web server simply has no page.
    ctx.inject?.(["webServer", "connection"], (host) => {
        const connection = Reflect.get(host, "connection");
        // Warm the model list while DSH starts, so neither the picker nor the Settings page waits on a cold AGY.
        void adapter.catalogStatus({ fresh: false }).catch(() => undefined);
        ctx.effect?.(() => host.webServer.register({ kind: "prefix", path: ROUTE, handler: nodeHandler({ settings, status }, (req) => (connection ? connection.requestRejection(req) : 503)) }), "dsh-oh-my-gravity: settings routes");
    });
    return async () => {
        await adapter.close();
        await (await bridge)?.close();
    };
};
//# sourceMappingURL=gravity.js.map