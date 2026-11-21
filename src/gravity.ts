import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import type { DshToolsRegistry, PluginContext } from "./dsh.js";
import { GRAVITY_PROVIDER, GravityAdapter } from "./gravity-adapter.js";
import { gravityToolRows } from "./gravity-tool-rows.js";
import { fileResumeMap } from "./gravity-store.js";
import { fileSettings } from "./gravity-settings.js";
import { nodeHandler, ROUTE, throttled, type SettingsStatus } from "./gravity-settings-routes.js";
import { startToolBridge, type ToolBridge } from "./gravity-mcp.js";
import { readOnlyRefusal } from "./gravity-plan-gate.js";
import { agyEnv } from "./gravity-env.js";
import { createQuotaService } from "./gravity-quota.js";

export const name = "dsh-oh-my-gravity";
export const inject = ["llm", "sessions", "connection"];
export const Config = z.object({
  command: z.string().default("agy").description("Path to your signed-in Antigravity CLI."),
  idleMinutes: z.number().min(1).default(30).description("Stop a session's Antigravity process (about 240 MB) after this many idle minutes; it resumes on the next message."),
  maxProcesses: z.number().min(1).default(4).description("Most Antigravity processes kept alive at once; the longest idle is stopped first."),
  models: z.array(z.string()).default([]).description("Model ids to offer in the picker, e.g. gemini-3.8-flash. Empty offers every model AGY reports."),
});

type GravityContext = {
  llm: {
    [K in "registerAdapter" | "registerConfigurableProviders"]: (
      ...args: Parameters<PluginContext["llm"][K]>
    ) => void;
  };
  sessions: Pick<PluginContext["sessions"], "get">;
  /** Present on a real DSH; the Settings routes need its web server. */
  inject?: (services: string[], callback: (host: { webServer: { register(route: { kind: "prefix"; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): unknown } }) => void) => void;
  effect?: (execute: () => unknown, label?: string) => void;
  get?: {
    (name: "agents"): Pick<PluginContext["agents"], "get"> | undefined;
    (name: "approval"): Pick<PluginContext["approval"], "request"> | undefined;
    (name: "connection"): { requestRejection(req: IncomingMessage): number | undefined } | undefined;
    (name: "tools"): Pick<DshToolsRegistry, "schemas" | "get"> | undefined;
  };
};

// Cordis constructs callbacks with a prototype; a plain arrow preserves the returned disposer.
export const apply = (ctx: GravityContext, config: Schemastery.TypeT<typeof Config>) => {
  const env = agyEnv(process.env, join(homedir(), ".local", "bin"), delimiter);
  // Started on the first turn that can use it, so a profile without DSH tools never opens a port.
  let bridge: Promise<ToolBridge | undefined> | undefined;
  const toolBridge = () => bridge ??= (async () => {
    const tools = ctx.get?.("tools");
    return tools && startToolBridge(
      tools,
      (id) => ctx.get?.("agents")?.get(id as never),
      (id, tool) => readOnlyRefusal(adapter.accessOf(id), tool),
    );
  })().catch(() => undefined);
  const stateDir = process.env.DSH_GRAVITY_STATE_DIR || join(homedir(), ".local", "state", "dsh-oh-my-gravity");
  const settings = fileSettings();
  let onTurnComplete = () => {};
  const adapter = new GravityAdapter({
    command: config.command,
    args: ["acp", "--sandbox"],
    fullAccessArgs: ["acp", "--dangerously-skip-permissions"],
    env,
    models: config.models,
    idleMs: config.idleMinutes * 60_000,
    maxProcesses: config.maxProcesses,
    hidden: () => settings.get().hiddenModels,
    catalogFile: join(stateDir, "catalog.json"),
    onTurnComplete: () => onTurnComplete(),
    log: (message) => console.warn(`[dsh-oh-my-gravity] ${message}`),
  }, (id) => {
    const cwd = id && ctx.sessions.get(id)?.header.cwd;
    return cwd && isAbsolute(cwd) ? cwd : undefined;
  }, async ({ sessionId, callId, toolName, reason, signal }) => {
    const agent = ctx.get?.("agents")?.get(sessionId);
    const approval = ctx.get?.("approval");
    if (!agent?.session || agent.session !== ctx.sessions.get(sessionId) || !approval || signal.aborted) return "unavailable";
    return approval.request({ agent, callId, toolName, reason, signal });
  }, fileResumeMap(), (id, model) => {
    const session = ctx.sessions.get(id);
    return session && gravityToolRows(session, GRAVITY_PROVIDER, model);
  }, async (id) => (settings.get().dshTools ? (await toolBridge())?.issue(id) : undefined));
  const quotaService = createQuotaService({
    command: config.command,
    env,
    cacheFile: join(stateDir, "quota.json"),
    getPlan: async () => (await adapter.catalogStatus({ fresh: false })).plan,
    log: (message) => console.warn(`[dsh-oh-my-gravity] ${message}`),
  });
  onTurnComplete = () => quotaService.noteTurnCompleted();
  ctx.llm.registerConfigurableProviders([{
    provider: GRAVITY_PROVIDER,
    displayName: "Oh My Gravity",
    settingsNs: `llm-${GRAVITY_PROVIDER}`,
    settingsPath: [],
  }]);
  ctx.llm.registerAdapter([GRAVITY_PROVIDER], adapter);
  // `agy --version` is asked once and remembered; "Check again" asks anew.
  let versionRead: Promise<string | undefined> | undefined;
  const readVersion = (fresh: boolean) => (!fresh && versionRead) || (versionRead = new Promise<string | undefined>((resolve) =>
    execFile(config.command, ["--version"], { env, timeout: 5000 }, (error, out) => resolve(error ? undefined : out.trim() || undefined))));
  void readVersion(false);
  const check = async (fresh: boolean): Promise<SettingsStatus> => {
    const [version, seen] = await Promise.all([readVersion(fresh), adapter.catalogStatus({ fresh })]);
    return { command: config.command, ...(version ? { version } : {}), signedIn: seen.signedIn, ...(seen.plan ? { plan: seen.plan } : {}), models: seen.models, lockedModels: config.models.length ? seen.models.map((m) => m.id).filter((id) => !config.models.includes(id)) : [] };
  };
  // Opening the page reads what is already known and starts nothing; the forced check starts AGY, so one at a time, reused for 5 seconds.
  const forced = throttled(() => check(true), 5000);
  const status = (fresh: boolean) => (fresh ? forced() : check(false));
  // The Settings page's API; a composition without a web server simply has no page.
  ctx.inject?.(["webServer", "connection"], (host) => {
    const connection = Reflect.get(host, "connection") as { requestRejection(req: IncomingMessage): number | undefined } | undefined;
    // Warm the model list and quota while DSH starts, so neither the picker, quota meter, nor Settings waits on a cold AGY.
    void adapter.catalogStatus({ fresh: false }).catch(() => undefined);
    void quotaService.get({ fresh: false }).catch(() => undefined);
    ctx.effect?.(() => host.webServer.register({
      kind: "prefix",
      path: ROUTE,
      handler: nodeHandler(
        { settings, status, quota: (fresh) => quotaService.get({ fresh }) },
        (req) => (connection ? connection.requestRejection(req) : 503),
      ),
    }), "dsh-oh-my-gravity: settings routes");
  });
  return async () => {
    quotaService.close();
    await adapter.close();
    await (await bridge)?.close();
  };
};
