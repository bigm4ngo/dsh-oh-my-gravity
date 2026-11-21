import assert from "node:assert/strict";
import { createUserMessage, type GenerateOptions } from "@deepseek-ai/dsh-llm";
import { GravityAdapter } from "./gravity-adapter.js";

// Fake AGY echoes the mcpServers it was given at session/new.
const script = String.raw`
const send = m => console.log(JSON.stringify({jsonrpc:'2.0',...m}));
let servers;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({id:m.id,result:{protocolVersion:1}});
  if (m.method === 'session/new') { servers = m.params.mcpServers; return send({id:m.id,result:{sessionId:'s'}}); }
  if (m.method === 'session/prompt') {
    send({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(servers)}}}});
    send({id:m.id,result:{stopReason:'end_turn'}});
  }
});`;
const config = { type: "http" as const, name: "dsh" as const, url: "http://127.0.0.1:1/mcp", headers: [{ name: "x-gravity-key", value: "k" }] };
const asked: string[] = [];
let revoked = 0;
const adapter = new GravityAdapter({ command: process.execPath, args: ["-e", script], env: process.env }, () => process.cwd(),
  undefined, undefined, undefined, async (id) => { asked.push(id); return { config, revoke: () => { revoked++; } }; });
const run = async (extra: Partial<GenerateOptions>) => {
  let text = "";
  for await (const c of adapter.stream({ provider: "antigravity", model: "default", sessionId: "dsh-1" as GenerateOptions["sessionId"],
    messages: [createUserMessage({ content: [{ type: "text", text: "hi" }], source: { kind: "user" } })], ...extra })) if (c.type === "text-delta") text += c.text;
  return text;
};
assert.deepEqual(JSON.parse(await run({})), [config]);
// Side requests (titles, compaction) carry no session key and get no DSH tools.
assert.deepEqual(JSON.parse(await run({ purpose: "session-title" } as never)), []);
assert.deepEqual(asked, ["dsh-1"]);
assert.equal(revoked, 0);
await adapter.close();
assert.equal(revoked, 1); // the credential dies with its AGY process

// Bridged mcp_dsh_* permissions defer to the DSH tool bridge (with callId correlated) instead of prompting twice.
const permScript = String.raw`
const send = m => console.log(JSON.stringify({jsonrpc:'2.0',...m}));
let pendingPrompt;
const asks = [
  { id: 'p1', toolCall: { toolCallId: 'c1', name: 'mcp_dsh_echo', kind: 'other' } },
  { id: 'p2', toolCall: { toolCallId: 'c2', name: 'mcp_dsh_unowned', kind: 'other' } },
  { id: 'p3', toolCall: { toolCallId: 'c3', name: 'run_command', kind: 'execute', rawInput: { CommandLine: 'ls' } } },
];
let step = 0;
function askNext() {
  const next = asks[step++];
  if (!next) return send({ id: pendingPrompt.id, result: { stopReason: 'end_turn' } });
  send({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'tool_call', ...next.toolCall } } });
  send({ id: next.id, method: 'session/request_permission', params: { sessionId: 's', toolCall: next.toolCall, options: [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_once', optionId: 'no' }] } });
}
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({id:m.id,result:{protocolVersion:1}});
  if (m.method === 'session/new') return send({id:m.id,result:{sessionId:'s'}});
  if (m.method === 'session/prompt') { pendingPrompt = m; return askNext(); }
  if (m.id === 'p1' || m.id === 'p2' || m.id === 'p3') {
    if (m.result?.outcome?.optionId !== 'yes') process.exit(4);
    return askNext();
  }
});`;
const approvedCalls: Array<{ toolName: string; callId: string; reason: string }> = [];
const rowIds = new Map([["c1", "row-uuid-1"], ["c2", "row-uuid-2"], ["c3", "row-uuid-3"]]);
const deferAdapter = new GravityAdapter(
  { command: process.execPath, args: ["-e", permScript], env: process.env },
  () => process.cwd(),
  async (req) => {
    approvedCalls.push({ toolName: req.toolName, callId: req.callId, reason: req.reason });
    return "allowed-once";
  },
  undefined,
  () => ({ callId: (id: string) => rowIds.get(id), update() {}, finish() {} }) as never,
  async () => ({
    config,
    revoke() {},
    ownsTool: (tool: string) => tool === "echo",
  }),
);
try {
  for await (const _ of deferAdapter.stream({
    provider: "antigravity",
    model: "default",
    sessionId: "dsh-2" as GenerateOptions["sessionId"],
    messages: [createUserMessage({ content: [{ type: "text", text: "go" }], source: { kind: "user" } })],
  })) { /* drain */ }
} finally {
  await deferAdapter.close();
}
assert.deepEqual(approvedCalls.map((c) => [c.toolName, c.callId]), [
  ["mcp_dsh_unowned", "row-uuid-2"],
  ["run_command", "row-uuid-3"],
]);
assert.match(approvedCalls[1]!.reason, /ls/);

console.log("gravity adapter mcp: ok");
