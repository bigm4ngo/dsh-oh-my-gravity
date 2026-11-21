import assert from "node:assert/strict";
import { createUserMessage, type GenerateOptions } from "@deepseek-ai/dsh-llm";
import { GravityAdapter } from "./gravity-adapter.js";
import type { ApprovalOutcome } from "./dsh.js";

// Real stdio transport. The child checks that the adapter uses the intended wire requests.
const script = String.raw`
const send = value => console.log(JSON.stringify({jsonrpc:'2.0',...value}));
let turns = 0;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({id:m.id,result:{protocolVersion:1}});
  if (m.method === 'session/new') {
    if (m.params.cwd !== process.cwd() || m.params.mcpServers.length) process.exit(20);
    return send({id:m.id,result:{sessionId:'fixture'}});
  }
  if (m.method === 'session/cancel') process.exit(21);
  if (m.method !== 'session/prompt' || m.params.sessionId !== 'fixture') process.exit(22);
  const prompt = m.params.prompt[0];
  const update = (sessionId, text, sessionUpdate='agent_message_chunk') =>
    send({method:'session/update',params:{sessionId,update:{sessionUpdate,content:{type:'text',text}}}});
  update('other-session','not for this turn');
  update('fixture','thinking','agent_thought_chunk');
  update('fixture','turn ' + (++turns) + ': ');
  update('fixture',prompt.text);
  send({id:m.id,result:{stopReason:'end_turn',usage:{inputTokens:12,cachedReadTokens:4,cachedWriteTokens:1,outputTokens:5,thoughtTokens:2,totalTokens:17}}});
});`;
const adapter = new GravityAdapter({ command: process.execPath, args: ["-e", script], env: process.env }, () => process.cwd());
const options = (text: string, session = "same"): GenerateOptions => ({
  provider: "antigravity", model: "default", sessionId: session as GenerateOptions["sessionId"],
  messages: [createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } })],
});
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}

try {
  for (const [n, word, session] of [[1, "alpha", "same"], [2, "beta", "same"], [1, "gamma", "other"]] as const) {
    const chunks = await collect(adapter.stream(options(word, session)));
    assert.deepEqual(chunks, [
      { type: "block-start", index: 0, blockType: "reasoning" },
      { type: "reasoning-delta", index: 0, text: "thinking" },
      { type: "block-end", index: 0, block: { type: "reasoning", text: "thinking" } },
      { type: "block-start", index: 1, blockType: "text" },
      { type: "text-delta", index: 1, text: `turn ${n}: ` },
      { type: "text-delta", index: 1, text: word },
      { type: "block-end", index: 1, block: { type: "text", text: `turn ${n}: ${word}` } },
      { type: "usage", usage: { inputTokens: 7, outputTokens: 5, totalTokens: 17, cacheReadTokens: 4, cacheWriteTokens: 1, reasoningTokens: 2 } },
      { type: "finish", reason: { kind: "stop" } },
    ]);
  }
  await assert.rejects(collect(adapter.stream({ ...options("wrong"), model: "unverified" })), /does not offer model/);
} finally {
  await adapter.close();
}
await assert.rejects(collect(adapter.stream(options("after close"))), /closed/);

const permissionFixture = String.raw`
const send = m => console.log(JSON.stringify({jsonrpc:'2.0',...m}));
let prompt;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({id:m.id,result:{protocolVersion:1}});
  if (m.method === 'session/new') return send({id:m.id,result:{sessionId:'fixture'}});
  if (m.method === 'session/prompt') {
    prompt = m;
    const text = m.params.prompt[0].text;
    return send({id:'ask',method:'session/request_permission',params:{
      sessionId: text === 'other-session' ? 'wrong' : 'fixture',
      toolCall:{toolCallId:'call-1',title:'Read synthetic fixture',kind:'read'},
      options:[{kind:'allow_always',optionId:text === 'ambiguous' ? 'yes' : 'persistent'}, {kind:'allow_once',optionId:'yes'}, {kind:'reject_once',optionId:'no'}],
    }});
  }
  if (m.id !== 'ask') process.exit(2);
  const decision = m.result?.outcome;
  const expected = {allow:'yes',reject:'no','other-session':'cancelled',missing:'cancelled',ambiguous:'cancelled'}[prompt.params.prompt[0].text];
  if ((decision?.optionId ?? decision?.outcome) !== expected) process.exit(3);
  send({id:prompt.id,result:{stopReason:'end_turn'}});
});`;
const requests: unknown[] = [];
let outcome: ApprovalOutcome = 'allowed-once';
const permissions = new GravityAdapter({ command: process.execPath, args: ['-e', permissionFixture], env: process.env }, () => process.cwd(), async (request: { callId: string; toolName: string; sessionId: string; signal: AbortSignal }) => {
  requests.push([request.sessionId, request.callId, request.toolName, request.signal.aborted]);
  return outcome;
});
try {
  for (const [word, answer] of [['allow', 'allowed-once'], ['reject', 'rejected'], ['other-session', 'allowed-once'], ['missing', 'unavailable'], ['ambiguous', 'allowed-once']] as const) {
    outcome = answer;
    // A refusal ends AGY's turn without a word; say why instead of leaving an empty reply.
    const note = "Antigravity stopped because permission for Read synthetic fixture was not granted.";
    const refused = word === 'reject' || word === 'missing';
    assert.deepEqual(await collect(permissions.stream(options(word))), [
      ...(refused ? [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: note }, { type: 'block-end', index: 0, block: { type: 'text', text: note } }] : []),
      { type: 'finish', reason: { kind: 'stop' } },
    ]);
  }
  assert.deepEqual(requests, Array.from({ length: 3 }, () => ['same', 'call-1', 'Read synthetic fixture', false]));
} finally {
  await permissions.close();
}
// The journal gets one line per relayed request: what AGY asked, and who answered.
const lines: string[] = [];
const logged = new GravityAdapter({ command: process.execPath, args: ['-e', permissionFixture], env: process.env, log: (m: string) => lines.push(m) }, () => process.cwd(), async () => (outcome));
try {
  outcome = 'allowed-once'; await collect(logged.stream(options('allow')));
  outcome = 'rejected'; await collect(logged.stream(options('reject')));
} finally {
  await logged.close();
}
assert.ok(lines.some((l) => /permission "Read synthetic fixture" \(read\) → DSH allowed-once/.test(l)), JSON.stringify(lines));
assert.ok(lines.some((l) => /permission "Read synthetic fixture" \(read\) → DSH rejected/.test(l)), JSON.stringify(lines));

console.log("gravity adapter: ok");
