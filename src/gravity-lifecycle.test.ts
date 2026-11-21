import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserMessage, type GenerateOptions } from "@deepseek-ai/dsh-llm";
import { GravityAdapter } from "./gravity-adapter.js";
import { fileResumeMap } from "./gravity-store.js";

// Fake AGY: one conversation file per session/new, like the real thing; `spawns` counts process starts.
const dir = mkdtempSync(join(tmpdir(), "gravity-life-"));
const conv = join(dir, "conversations");
mkdirSync(conv);
const spawns = join(dir, "spawns");
const script = String.raw`
const fs = require('fs'); const send = m => console.log(JSON.stringify({jsonrpc:'2.0',...m}));
fs.appendFileSync(process.env.SPAWNS, 'x');
let how = 'new';
require('readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({id:m.id,result:{protocolVersion:1}});
  if (m.method === 'session/new') { const id = 'sess-' + process.pid; fs.writeFileSync(process.env.CONVDIR + '/' + id + '.db', 'db'); fs.writeFileSync(process.env.CONVDIR + '/' + id + '.db-wal', 'w'); return send({id:m.id,result:{sessionId:id}}); }
  if (m.method === 'session/load') { how = 'loaded'; return send({id:m.id,result:{}}); }
  if (m.method === 'session/close') return send({id:m.id,result:{}});
  if (m.method === 'session/prompt') {
    send({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:how}}}});
    send({id:m.id,result:{stopReason:'end_turn'}});
  }
});`;
const count = () => (existsSync(spawns) ? readFileSync(spawns, "utf8").length : 0);
const resume = fileResumeMap(join(dir, "sessions.json"));
const make = (extra: object = {}) => new GravityAdapter({
  command: process.execPath, args: ["-e", script], conversationsDir: conv, env: { ...process.env, SPAWNS: spawns, CONVDIR: conv }, ...extra,
}, () => process.cwd(), undefined, resume);
const turn = async (a: GravityAdapter, key: string) => {
  let text = "";
  for await (const c of a.stream({ provider: "antigravity", model: "default", sessionId: key as GenerateOptions["sessionId"],
    messages: [createUserMessage({ content: [{ type: "text", text: "hi" }], source: { kind: "user" } })] })) if (c.type === "text-delta") text += c.text;
  return text;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The model-list probe leaves no conversation behind in AGY's history; a real DSH session's conversation stays (it is resumable).
let a = make();
await a.listModels("antigravity");
assert.deepEqual(readdirSync(conv), [], "probe left a conversation file");
assert.equal(await turn(a, "k0"), "new");
assert.equal(readdirSync(conv).filter((f) => f.endsWith(".db")).length, 1);
await a.close();
// Only our own throwaway id is ever removed: a hostile id never reaches outside the conversations folder.
writeFileSync(join(dir, "outside.db"), "keep");
const evil = make({ args: ["-e", script.replace("'sess-' + process.pid", "'../outside'")] });
await evil.listModels("antigravity");
assert.ok(existsSync(join(dir, "outside.db")), "removed a file outside the conversations folder");
await evil.close();

// An idle AGY process (about 240 MB each) is stopped, and its conversation comes back by session/load on the next turn.
a = make({ idleMs: 150, reapEveryMs: 40 });
assert.equal(await turn(a, "k1"), "new");
assert.equal(a.processCount(), 1);
await sleep(600);
assert.equal(a.processCount(), 0, "idle process was not stopped");
const before = count();
assert.equal(await turn(a, "k1"), "loaded");
assert.equal(count(), before + 1);
await a.close();

// At most `maxProcesses` stay alive; the longest idle is the one stopped, and it still resumes.
a = make({ maxProcesses: 2, idleMs: 600_000 });
await turn(a, "m1"); await sleep(20);
await turn(a, "m2"); await sleep(20);
await turn(a, "m3");
assert.equal(a.processCount(), 2);
assert.equal(await turn(a, "m1"), "loaded");
assert.equal(a.processCount(), 2);
await a.close();
console.log("gravity lifecycle: ok");
