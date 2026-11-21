import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { apply, name, Config, inject } from "./gravity.js";
import type { PluginContext } from "./dsh.js";

let route: Parameters<PluginContext["llm"]["registerAdapter"]> | undefined;
let listing: Parameters<PluginContext["llm"]["registerConfigurableProviders"]>[0] | undefined;
const config = Config({});
const unload = apply({
  llm: {
    registerConfigurableProviders: (providers) => { listing = providers; },
    registerAdapter: (providers, adapter) => { route = [providers, adapter]; },
  },
  sessions: { get: () => undefined },
}, config);
try {
  assert.equal(config.command, "agy");
  assert.deepEqual(config.models, []);
  assert.equal(name, "dsh-oh-my-gravity");
  assert.deepEqual(route?.[0], ["antigravity"]);
  assert.deepEqual(route?.[1].providerInfo("antigravity"), { id: "antigravity", name: "Oh My Gravity" });
  assert.equal(listing?.[0]?.provider, "antigravity");
  assert.equal(listing?.[0]?.settingsNs, "llm-antigravity");
} finally {
  await unload();
}
const adapter = route?.[1];
assert.ok(adapter);
await assert.rejects(async () => {
  for await (const _ of adapter.stream({ provider: "antigravity", model: "default", messages: [] })) {
    // An unloaded provider must reject before emitting any turn events.
  }
}, /closed/);
const ctx = new Context();
let rejection: number | undefined;
let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
const services = ctx.plugin({ apply(host) {
  host.provide("llm", {
    registerConfigurableProviders() {},
    registerAdapter(_routes: string[], value: typeof adapter) { mountedAdapter = value; },
  });
  host.provide("sessions", { get() { return undefined; } });
  host.provide("connection", { requestRejection() { return rejection; } });
  host.provide("webServer", { register(route: { handler: (req: unknown, res: unknown) => Promise<void> }) { handler = route.handler; return () => {}; } });
} });
let mountedAdapter: typeof adapter | undefined;
try {
  await services.await();
  // The injected test services are present at runtime; Cordis's generic Context does not declare them.
  const mount = ctx.plugin({ name, Config, inject, apply: apply as unknown as (ctx: Context, options: typeof config) => unknown }, {});
  await mount.await();
  assert.ok(mountedAdapter);
  // The Settings route asks DSH's connection service: an allowed request is served, a refused one gets that status.
  const ask = async () => {
    let status = 0;
    const res = { writeHead(code: number) { status = code; }, end() {} };
    await handler?.({ url: "/dsh-oh-my-gravity/api/nothing", method: "GET", headers: {} }, res);
    return status;
  };
  assert.ok(handler, "settings route registered");
  assert.equal(await ask(), 404);
  rejection = 401;
  assert.equal(await ask(), 401);
  await mount.dispose();
  const mounted = mountedAdapter;
  await assert.rejects(async () => {
    for await (const _ of mounted.stream({ provider: "antigravity", model: "default", messages: [] })) {
      assert.fail("unloaded adapter emitted a chunk");
    }
  }, /closed/);
} finally {
  await services.dispose();
}
console.log("gravity registration: ok");
