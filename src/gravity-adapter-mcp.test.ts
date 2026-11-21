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
console.log("gravity adapter mcp: ok");
