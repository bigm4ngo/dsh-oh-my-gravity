import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSettings } from "./gravity-settings.js";
import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { handleSettings, nodeHandler, throttled, type SettingsStatus } from "./gravity-settings-routes.js";

const dir = mkdtempSync(join(tmpdir(), "gravity-settings-"));
const file = join(dir, "settings.json");

// Defaults, persistence, and a damaged file never breaking the plugin.
const store = fileSettings(file);
assert.deepEqual(store.get(), { hiddenModels: [], dshTools: true });
store.set({ hiddenModels: ["claude-sonnet-4-6"], dshTools: false });
assert.deepEqual(fileSettings(file).get(), { hiddenModels: ["claude-sonnet-4-6"], dshTools: false });
writeFileSync(file, "{not json");
assert.deepEqual(fileSettings(file).get(), { hiddenModels: [], dshTools: true });
writeFileSync(file, JSON.stringify({ hiddenModels: ["ok", 7, "", null], dshTools: "yes", approvals: "sure", extra: 1 }));
assert.deepEqual(fileSettings(file).get(), { hiddenModels: ["ok"], dshTools: true });

// Routes.
const status: SettingsStatus = { command: "agy", version: "1.5.13", signedIn: true, models: [{ id: "m-a", name: "Model A" }], lockedModels: ["m-b"] };
const live = fileSettings(join(dir, "routes.json"));
const freshAsked: boolean[] = [];
const call = async (method: string, path: string, body?: unknown, raw?: string) => {
  const response = await handleSettings(new Request(`http://x/dsh-oh-my-gravity${path}`, {
    method, ...(body !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  }), { settings: live, status: async (fresh) => { freshAsked.push(fresh); return status; } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};
assert.deepEqual(await call("GET", "/api/status"), { status: 200, body: { ...status, settings: { hiddenModels: [], dshTools: true } } });
// Opening the page answers from what is already known; only "Check again" (?fresh=1) asks AGY anew.
assert.equal((await call("GET", "/api/status?fresh=1")).status, 200);
assert.deepEqual(freshAsked, [false, true]);
assert.equal((await call("POST", "/api/settings", { hiddenModels: ["m-a"], dshTools: false })).status, 200);
assert.deepEqual(live.get(), { hiddenModels: ["m-a"], dshTools: false });
assert.equal((await call("POST", "/api/settings", { dshTools: true })).status, 200); // partial update keeps the rest
assert.deepEqual(live.get(), { hiddenModels: ["m-a"], dshTools: true });
for (const bad of [{ hiddenModels: "m-a" }, { hiddenModels: [1] }, { dshTools: "no" }, {}, []]) {
  assert.equal((await call("POST", "/api/settings", bad)).status, 400, JSON.stringify(bad));
}
assert.equal((await call("POST", "/api/settings", undefined, "{nope")).status, 400);
assert.equal((await call("POST", "/api/settings", undefined, "x".repeat(70_000))).status, 413);
assert.equal((await call("PUT", "/api/settings")).status, 405);
assert.equal((await call("POST", "/api/status")).status, 405);
assert.equal((await call("GET", "/api/nope")).status, 404);

// Browser-origin protection: a page on another origin (even another localhost port) cannot read or change anything.
const send = (init: RequestInit, path = "/api/settings") =>
  handleSettings(new Request(`http://x/dsh-oh-my-gravity${path}`, init), { settings: live, status: async (_fresh) => status });
const goodBody = JSON.stringify({ dshTools: false });
assert.equal((await send({ method: "POST", body: goodBody, headers: { "content-type": "text/plain" } })).status, 415);
assert.equal((await send({ method: "POST", body: goodBody })).status, 415);
for (const site of ["cross-site", "same-site"]) {
  assert.equal((await send({ method: "POST", body: goodBody, headers: { "content-type": "application/json", "sec-fetch-site": site } })).status, 403);
  assert.equal((await send({ headers: { "sec-fetch-site": site } }, "/api/status")).status, 403);
}
assert.equal((await send({ headers: { "sec-fetch-site": "same-origin" } }, "/api/status")).status, 200);
assert.equal((await send({ method: "POST", body: goodBody, headers: { "content-type": "application/json; charset=utf-8", "sec-fetch-site": "same-origin" } })).status, 200);
live.set({ hiddenModels: ["m-a"], dshTools: true });
// The size cap counts bytes as they arrive: a declared length, or a stream that never declares one.
assert.equal((await send({ method: "POST", body: goodBody, headers: { "content-type": "application/json", "content-length": "999999" } })).status, 413);
const chunk = new TextEncoder().encode("x".repeat(40_000));
let pulled = 0;
const endless = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(chunk); } });
assert.equal((await send({ method: "POST", body: endless, duplex: "half", headers: { "content-type": "application/json" } } as RequestInit)).status, 413);
assert.ok(pulled < 10, `read ${pulled} chunks of an endless body`);
assert.deepEqual(live.get(), { hiddenModels: ["m-a"], dshTools: true }); // nothing above changed it
// DSH's `resource` routes answer GET and HEAD only, so the page's writes need a Node handler route. Over a real socket:
const wired = fileSettings(join(dir, "wired.json"));
const server = createServer((req, res) => { void nodeHandler({ settings: wired, status: async (_fresh) => status }, () => undefined)(req, res); });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dsh-oh-my-gravity`;
// A request DSH's connection service refuses never reaches the settings.
let deny: number | undefined = 401;
const guarded = createServer((req, res) => { void nodeHandler({ settings: wired, status: async (_fresh) => status }, () => deny)(req, res); });
await new Promise<void>((resolve) => guarded.listen(0, "127.0.0.1", resolve));
const gbase = `http://127.0.0.1:${(guarded.address() as AddressInfo).port}/dsh-oh-my-gravity`;
try {
  assert.equal((await fetch(`${gbase}/api/status`)).status, 401);
  const blocked = await fetch(`${gbase}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hiddenModels: ["x"] }) });
  assert.equal(blocked.status, 401);
  assert.equal(wired.get().hiddenModels.includes("x"), false);
  deny = undefined;
  assert.equal((await fetch(`${gbase}/api/status`)).status, 200);
} finally { guarded.close(); }
try {
  assert.equal((await fetch(`${base}/api/status`)).status, 200);
  const wrote = await fetch(`${base}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hiddenModels: ["m-a"] }) });
  assert.equal(wrote.status, 200);
  assert.deepEqual(wired.get().hiddenModels, ["m-a"]);
  assert.equal((await fetch(`${base}/api/settings`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await fetch(`${base}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(100_000) })).status, 413);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  // Malformed request lines and Host headers must come back as errors, never as an unhandled rejection.
  const port = (server.address() as AddressInfo).port;
  const raw = (head: string) => new Promise<string>((resolve) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(head));
    let got = "";
    socket.on("data", (d) => { got += d; if (got.includes("\r\n\r\n")) socket.end(); });
    socket.setTimeout(3000, () => { socket.destroy(); resolve("no answer"); }); // a hung request fails the match below
    socket.on("close", () => resolve(got.split("\r\n")[0] ?? ""));
    socket.on("error", () => resolve(got.split("\r\n")[0] ?? ""));
  });
  const lines = [
    await raw("GET http://[x/dsh-oh-my-gravity/api/status HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"),
    await raw("GET //evil.example/dsh-oh-my-gravity/api/status HTTP/1.1\r\nHost: a b\r\n\r\n"),
    await raw("GET /dsh-oh-my-gravity/api/status HTTP/1.1\r\nHost: [\r\n\r\n"),
  ];
  for (const line of lines) assert.match(line, /HTTP\/1\.1 (200|400|404|500)/, line);
  assert.equal((await fetch(`${base}/api/status`)).status, 200); // still serving
  assert.deepEqual(wired.get().hiddenModels, ["m-a"]);
} finally {
  server.close();
  server.closeAllConnections();
}

// The status probe runs AGY: concurrent callers share one run, a result is reused briefly, a failure is not kept.
let runs = 0;
let fail = false;
const probe = throttled(async () => { runs++; await new Promise((r) => setTimeout(r, 10)); if (fail) throw new Error("down"); return runs; }, 60);
assert.deepEqual(await Promise.all([probe(), probe(), probe()]), [1, 1, 1]);
assert.equal(await probe(), 1);
await new Promise((r) => setTimeout(r, 80));
fail = true;
await assert.rejects(probe(), /down/);
fail = false;
assert.equal(await probe(), 3); // the failed run was not cached
assert.equal(runs, 3);
console.log("gravity settings: ok");
