import assert from "node:assert/strict";
import { startToolBridge } from "./gravity-mcp.js";
import type { Agent, DshTool, JsonValue, ToolSchema } from "./dsh.js";

const agent = { id: "s1" } as unknown as Agent;
const calls: Array<{ args: Record<string, JsonValue>; agent: unknown; callId: string }> = [];
const schema = (name: string): ToolSchema => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} } });
const tools: Record<string, DshTool> = {
  echo: { execute: async (args, exec) => { calls.push({ args, agent: exec.agent, callId: exec.callId }); return { said: args.text ?? null }; } },
  boom: { execute: async () => { throw new Error("kaput"); } },
  read: { execute: async () => "must never run" },
};
const asked: Array<{ session: string; tool: string; args: unknown; aborted: boolean }> = [];
let verdict: string | Error = "allowed-once";
let refuse: string | undefined;
const bridge = await startToolBridge(
  { schemas: () => ["read", "echo", "boom", "run_code"].map(schema), get: (name) => tools[name] },
  (id) => (id === "s1" ? agent : undefined),
  async (session, tool, args, signal) => {
    asked.push({ session, tool, args, aborted: signal.aborted });
    if (verdict instanceof Error) throw verdict;
    return verdict as never;
  },
  (_session, tool) => (tool === "echo" ? refuse : undefined),
);
const post = (key: string | undefined, body: unknown, raw = false) => fetch(bridge.url, {
  method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-gravity-key": key } : {}) },
  body: raw ? (body as string) : JSON.stringify(body),
});
const rpc = async (key: string, method: string, params: object = {}) =>
  (await (await post(key, { jsonrpc: "2.0", id: 1, method, params })).json()) as { result?: any; error?: any };
try {
  const grant = bridge.issue("s1");
  assert.equal(grant.config.type, "http");
  assert.equal(grant.config.url, bridge.url);
  const key = grant.config.headers[0]!.value;

  assert.equal((await post(undefined, {})).status, 401);
  assert.equal((await post("wrong", {})).status, 401);
  assert.equal((await fetch(bridge.url, { headers: { "x-gravity-key": key } })).status, 405);
  assert.equal((await post(key, "x".repeat(2 * 1024 * 1024), true)).status, 413);
  assert.equal((await post(key, "{nope", true)).status, 400);

  assert.equal((await rpc(key, "initialize", { protocolVersion: "2025-06-18" })).result.protocolVersion, "2025-06-18");
  // AGY has its own file tools and DSH's code-mode transport is not a tool: both stay off the list.
  assert.deepEqual((await rpc(key, "tools/list")).result.tools.map((t: { name: string }) => t.name), ["echo", "boom"]);

  const ok = (await rpc(key, "tools/call", { name: "echo", arguments: { text: "hi" } })).result;
  assert.deepEqual(ok.content, [{ type: "text", text: '{"said":"hi"}' }]);
  assert.equal(calls.length, 1);
  // Every call needs DSH's approval, whatever AGY's own settings allowed.
  assert.deepEqual(asked.map((a) => [a.session, a.tool, a.args]), [["s1", "echo", { text: "hi" }]]);
  for (const refused of ["rejected", "cancelled", "unavailable"]) {
    verdict = refused;
    const denied = (await rpc(key, "tools/call", { name: "echo", arguments: { text: "no" } })).result;
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /not approved/);
  }
  // A session DSH holds read-only may not run a tool that changes things; refused before DSH is even asked.
  refuse = "read-only session";
  asked.length = 0;
  const blocked = (await rpc(key, "tools/call", { name: "echo", arguments: { text: "x" } })).result;
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /read-only session/);
  assert.equal(asked.length, 0);
  assert.equal(calls.length, 1);
  refuse = undefined;
  verdict = new Error("no open turn"); // an approval service that cannot ask fails closed
  assert.equal((await rpc(key, "tools/call", { name: "echo", arguments: {} })).result.isError, true);
  verdict = "allowed-once";
  assert.equal(calls.length, 1);
  calls.length = 1;
  assert.equal(calls[0]!.agent, agent);
  assert.deepEqual(calls[0]!.args, { text: "hi" });

  const failed = (await rpc(key, "tools/call", { name: "boom", arguments: {} })).result;
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /kaput/);
  assert.equal((await rpc(key, "tools/call", { name: "read", arguments: {} })).result.isError, true); // hidden tools cannot be called either
  assert.equal(calls.length, 1);

  // A key is bound to one session whose agent must still exist; revoking ends access at once.
  assert.equal((await rpc(bridge.issue("gone").config.headers[0]!.value, "tools/list")).error?.code, -32000);
  grant.revoke();
  assert.equal((await post(key, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 401);
} finally {
  await bridge.close();
}
await assert.rejects(fetch(bridge.url), /./);
console.log("gravity mcp: ok");
