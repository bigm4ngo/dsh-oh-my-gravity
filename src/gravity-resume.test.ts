import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserMessage, type GenerateOptions } from "@deepseek-ai/dsh-llm";
import { GravityAdapter } from "./gravity-adapter.js";
import { fileResumeMap } from "./gravity-store.js";

// Fake AGY: ids come from a counter in the env; loading "gone" fails; each reply reports how the session began and the prompt it got.
const script = String.raw`
const send = m => console.log(JSON.stringify({jsonrpc:'2.0',...m}));
let how = 'new';
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({id:m.id,result:{protocolVersion:1}});
  if (m.method === 'session/new') return send({id:m.id,result:{sessionId:'agy-'+process.pid}});
  if (m.method === 'session/load') {
    if (m.params.sessionId === 'gone') return send({id:m.id,error:{code:-32602,message:'unknown session'}});
    how = 'loaded:' + m.params.sessionId;
    send({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'REPLAYED OLD HISTORY'}}}});
    return send({id:m.id,result:{}});
  }
  if (m.method === 'session/prompt') {
    send({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:how+'|'+m.params.prompt[0].text}}}});
    send({id:m.id,result:{stopReason:'end_turn'}});
  }
});`;
const file = join(mkdtempSync(join(tmpdir(), "gravity-resume-")), "sessions.json");
const make = () => new GravityAdapter({ command: process.execPath, args: ["-e", script], env: process.env }, () => process.cwd(), undefined, fileResumeMap(file));
const user = (text: string) => createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
async function say(adapter: GravityAdapter, messages: GenerateOptions["messages"]) {
  let text = "";
  for await (const c of adapter.stream({ provider: "antigravity", model: "default", sessionId: "dsh-1" as GenerateOptions["sessionId"], messages })) if (c.type === "text-delta") text += c.text;
  return text;
}
const first = make();
const firstReply = await say(first, [user("one")]);
assert.match(firstReply, /^new\|one$/);
const agyId = fileResumeMap(file).get("dsh-1")?.agyId;
assert.match(agyId ?? "", /^agy-\d+$/);
await first.close();

// After a "restart": loads the saved conversation and sends only the new user turn, not the replayed history.
const second = make();
const history = [user("one"), { ...user("answer"), role: "assistant" as const }, user("two")] as unknown as GenerateOptions["messages"];
assert.equal(await say(second, history), `loaded:${agyId}|two`);
await second.close();

// A conversation AGY no longer has falls back to a fresh one with the full history, and the stale mapping is replaced.
fileResumeMap(file).set("dsh-1", "gone", process.cwd());
const third = make();
const fallback = await say(third, [user("one"), { ...user("answer"), role: "assistant" as const } as never, user("two")]);
assert.match(fallback, /^new\|one\n\nassistant: answer\n\ntwo$/);
assert.notEqual(fileResumeMap(file).get("dsh-1")?.agyId, "gone");
await third.close();
console.log("gravity resume: ok");
