import assert from "node:assert/strict";
import { createUserMessage, type GenerateOptions } from "@deepseek-ai/dsh-llm";
import { describePermission, fitPrompt, GravityAdapter, tokenUsage } from "./gravity-adapter.js";
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
  send({id:m.id,result:{stopReason:'end_turn',usage:{inputTokens:12,cachedReadTokens:4,cachedWriteTokens:1,outputTokens:5,thoughtTokens:2,totalTokens:22}}});
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
      { type: "usage", usage: { inputTokens: 12, outputTokens: 5, totalTokens: 22, cacheReadTokens: 4, cacheWriteTokens: 1, reasoningTokens: 2 } },
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
const permissions = new GravityAdapter({ command: process.execPath, args: ['-e', permissionFixture], env: process.env }, () => process.cwd(), async (request: { callId: string; toolName: string; reason: string; sessionId: string; signal: AbortSignal }) => {
  requests.push([request.sessionId, request.callId, request.toolName, request.signal.aborted, request.reason]);
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
  assert.deepEqual(requests, Array.from({ length: 3 }, () => ['same', 'call-1', 'Read synthetic fixture', false, 'Antigravity requested permission for Read synthetic fixture (read).']));
} finally {
  await permissions.close();
}

// describePermission preserves command flags/summaries, file line ranges, size bounds, and sanitization.
const cmdReason = describePermission("run_command", {
  name: "run_command",
  kind: "execute",
  rawInput: { CommandLine: "git push origin main", BypassSandbox: true, toolSummary: "Push branch" },
});
assert.match(cmdReason, /UNSANDBOXED, BypassSandbox: true/);
assert.match(cmdReason, /Push branch/);
assert.match(cmdReason, /git push origin main/);

const fileReason = describePermission("read_file", {
  name: "read_file",
  kind: "read",
  rawInput: { Path: "/tmp/example.ts", StartLine: 10, EndLine: 45 },
});
assert.equal(fileReason, "Antigravity wants to read_file /tmp/example.ts (lines 10-45)");

const hugeCmd = "x".repeat(5000);
const cappedReason = describePermission("run_command", {
  name: "run_command",
  rawInput: { CommandLine: hugeCmd },
});
assert.ok(cappedReason.length <= 4000, `length=${cappedReason.length}`);
assert.match(cappedReason, /COMMAND TRUNCATED: 5000 chars total/);

const dirtyReason = describePermission("run_command", {
  name: "run_command",
  title: "Run\x1b[31m\nCmd\0",
  rawInput: { CommandLine: "echo\nhi\x1b[0m\0" },
});
assert.equal(/[\u0000-\u001f\u007f]/.test(dirtyReason), false);
assert.match(dirtyReason, /echo hi \[0m/);

// End-to-end: rawInput sent on an earlier tool_call update survives into a stripped session/request_permission ask.
const metaFixture = String.raw`
const send = m => console.log(JSON.stringify({jsonrpc:'2.0',...m}));
let prompt;
let step = 0;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({id:m.id,result:{protocolVersion:1}});
  if (m.method === 'session/new') return send({id:m.id,result:{sessionId:'fixture'}});
  if (m.method === 'session/prompt') {
    prompt = m;
    send({ method: 'session/update', params: { sessionId: 'fixture', update: {
      sessionUpdate: 'tool_call', toolCallId: 'cmd-1', name: 'run_command', kind: 'execute',
      rawInput: { CommandLine: 'npm publish', BypassSandbox: true, toolSummary: 'Publish package' },
    } } });
    return send({ id: 'ask-1', method: 'session/request_permission', params: {
      sessionId: 'fixture',
      toolCall: { toolCallId: 'cmd-1', name: 'run_command', kind: 'execute' },
      options: [{ kind: 'allow_once', optionId: 'yes' }],
    } });
  }
  if (m.id === 'ask-1') {
    step++;
    return send({ id: 'ask-2', method: 'session/request_permission', params: {
      sessionId: 'fixture',
      toolCall: { toolCallId: 'cmd-2', name: 'run_command', kind: 'execute', rawInput: { CommandLine: 'ls -la', BypassSandbox: false } },
      options: [{ kind: 'allow_once', optionId: 'yes' }],
    } });
  }
  if (m.id === 'ask-2' && step === 1) return send({ id: prompt.id, result: { stopReason: 'end_turn' } });
});`;
const seenReasons: Array<{ toolName: string; reason: string }> = [];
const metaAdapter = new GravityAdapter(
  { command: process.execPath, args: ['-e', metaFixture], env: process.env },
  () => process.cwd(),
  async (request) => {
    seenReasons.push({ toolName: request.toolName, reason: request.reason });
    return 'allowed-once';
  },
);
try {
  await collect(metaAdapter.stream(options('go')));
} finally {
  await metaAdapter.close();
}
assert.equal(seenReasons.length, 2);
assert.match(seenReasons[0]!.reason, /UNSANDBOXED, BypassSandbox: true/);
assert.match(seenReasons[0]!.reason, /Publish package/);
assert.match(seenReasons[0]!.reason, /npm publish/);
assert.match(seenReasons[1]!.reason, /\[sandboxed\].*: ls -la/);

// End-to-end: ordinary outside reads auto-allow in workspace-write; sensitive reads & outside edits still ask; danger-full-access auto-allows all.
const policyFixture = String.raw`
const tag = process.argv[1];
const send = m => console.log(JSON.stringify({jsonrpc:'2.0',...m}));
let prompt;
let step = 0;
const asks = [
  { id: 'r1', toolCall: { toolCallId: 't1', name: 'read_file', kind: 'read', rawInput: { Path: '/home/euro/other/file.ts' } } },
  { id: 'r2', toolCall: { toolCallId: 't2', name: 'read_file', kind: 'read', rawInput: { Path: '/home/euro/.ssh/id_rsa' } } },
  { id: 'r3', toolCall: { toolCallId: 't3', name: 'edit_file', kind: 'edit', rawInput: { Path: '/home/euro/other/file.ts' } } },
];
function nextAsk() {
  const a = asks[step++];
  if (!a) return send({ id: prompt.id, result: { stopReason: 'end_turn' } });
  return send({ id: a.id, method: 'session/request_permission', params: {
    sessionId: 'fixture',
    toolCall: a.toolCall,
    options: [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_once', optionId: 'no' }],
  } });
}
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({id:m.id,result:{protocolVersion:1}});
  if (m.method === 'session/new') return send({id:m.id,result:{sessionId:'fixture',modes:{currentModeId:'default',availableModes:[{id:'default'},{id:'auto'},{id:'plan'}]}}});
  if (m.method === 'session/set_mode') return send({id:m.id,result:{}});
  if (m.method === 'session/prompt') { prompt = m; step = 0; return nextAsk(); }
  if (m.id === 'r1' || m.id === 'r2' || m.id === 'r3') {
    if (m.result?.outcome?.optionId !== 'yes') process.exit(5);
    return nextAsk();
  }
});`;
const policyNote = (access: string) => createUserMessage({
  content: [{ type: 'text', text: `Current DSH file policy: ${access}.` }],
  source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'sandbox:policy', text: `Current DSH file policy: ${access}.` }] },
} as never);
const promptedTools: Array<{ toolName: string; reason: string }> = [];
const policyAdapter = new GravityAdapter(
  { command: process.execPath, args: ['-e', policyFixture, 'sandbox'], fullAccessArgs: ['-e', policyFixture, 'full'], env: process.env },
  () => process.cwd(),
  async (request) => {
    promptedTools.push({ toolName: request.toolName, reason: request.reason });
    return 'allowed-once';
  },
);
try {
  await collect(policyAdapter.stream({
    ...options('run1', 'policy-s'),
    messages: [policyNote('workspace-write'), createUserMessage({ content: [{ type: 'text', text: 'run1' }], source: { kind: 'user' } })],
  }));
  assert.equal(promptedTools.length, 2);
  assert.equal(promptedTools[0]!.toolName, 'read_file');
  assert.match(promptedTools[0]!.reason, /\/home\/euro\/\.ssh\/id_rsa/);
  assert.equal(promptedTools[1]!.toolName, 'edit_file');
  assert.match(promptedTools[1]!.reason, /\/home\/euro\/other\/file\.ts/);

  promptedTools.length = 0;
  await collect(policyAdapter.stream({
    ...options('run2', 'policy-s'),
    messages: [policyNote('danger-full-access'), createUserMessage({ content: [{ type: 'text', text: 'run2' }], source: { kind: 'user' } })],
  }));
  assert.equal(promptedTools.length, 0);
} finally {
  await policyAdapter.close();
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

// tokenUsage handles disjoint AGY counters, cacheReadTokens > inputTokens, reasoning clamp, zero cache, legacy inclusive, and contextUsed scaling.
assert.deepEqual(
  tokenUsage({ inputTokens: 2219, cachedReadTokens: 8516, cachedWriteTokens: 0, outputTokens: 29, thoughtTokens: 27, totalTokens: 10764 }),
  { inputTokens: 2219, outputTokens: 29, totalTokens: 10764, cacheReadTokens: 8516, cacheWriteTokens: 0, reasoningTokens: 27 },
);
assert.deepEqual(
  tokenUsage({ inputTokens: 10573, outputTokens: 86, thoughtTokens: 84, totalTokens: 10659 }),
  { inputTokens: 10573, outputTokens: 86, totalTokens: 10659, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 84 },
);
assert.deepEqual(
  tokenUsage({ inputTokens: 100, outputTokens: 10, thoughtTokens: 25, totalTokens: 110 }),
  { inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 10 },
);
assert.deepEqual(
  tokenUsage({ inputTokens: 12, cachedReadTokens: 4, cachedWriteTokens: 1, outputTokens: 5, totalTokens: 17 }),
  { inputTokens: 7, outputTokens: 5, totalTokens: 17, cacheReadTokens: 4, cacheWriteTokens: 1 },
);
// Single-step turn where prompt <= contextUsed is not scaled down.
assert.deepEqual(
  tokenUsage({ inputTokens: 2219, cachedReadTokens: 8516, cachedWriteTokens: 0, outputTokens: 29, totalTokens: 10764 }, 11000),
  { inputTokens: 2219, outputTokens: 29, totalTokens: 10764, cacheReadTokens: 8516, cacheWriteTokens: 0 },
);
// Multi-step turn where summed prompt (13548 + 13941 = 27489) exceeds usage_update.used (9603) scales prompt proportionally while keeping output intact.
const scaled = tokenUsage(
  { inputTokens: 13548, cachedReadTokens: 13941, cachedWriteTokens: 0, outputTokens: 389, thoughtTokens: 249, totalTokens: 27878 },
  9603,
);
assert.ok(scaled);
assert.equal(scaled.inputTokens + (scaled.cacheReadTokens ?? 0) + (scaled.cacheWriteTokens ?? 0), 9603);
assert.equal(scaled.outputTokens, 389);
assert.equal(scaled.reasoningTokens, 249);
assert.equal(scaled.totalTokens, 9603 + 389);
const originalHit = 13941 / 27489;
const scaledHit = (scaled.cacheReadTokens ?? 0) / 9603;
assert.ok(Math.abs(originalHit - scaledHit) < 0.001, `cache ratio drifted: ${originalHit} vs ${scaledHit}`);

// End-to-end: usage_update.used scales multi-step result.usage prompt counters emitted by GravityAdapter.stream().
const multiStepFixture = String.raw`
const send = m => console.log(JSON.stringify({jsonrpc:'2.0',...m}));
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({id:m.id,result:{protocolVersion:1}});
  if (m.method === 'session/new') return send({id:m.id,result:{sessionId:'fixture'}});
  if (m.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: 'fixture', update: { sessionUpdate: 'usage_update', used: 9056, size: 1048576 } } });
    send({ method: 'session/update', params: { sessionId: 'fixture', update: { sessionUpdate: 'usage_update', used: 9603, size: 1048576 } } });
    send({ method: 'session/update', params: { sessionId: 'fixture', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } });
    return send({ id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 13548, cachedReadTokens: 13941, cachedWriteTokens: 0, outputTokens: 389, thoughtTokens: 249, totalTokens: 27878 } } });
  }
});`;
const scaledAdapter = new GravityAdapter({ command: process.execPath, args: ['-e', multiStepFixture], env: process.env }, () => process.cwd());
try {
  const chunks = await collect(scaledAdapter.stream(options('multi', 'multi-s')));
  const usageChunk = chunks.find((c) => c.type === 'usage');
  assert.ok(usageChunk && usageChunk.type === 'usage');
  assert.equal(usageChunk.usage.inputTokens + (usageChunk.usage.cacheReadTokens ?? 0) + (usageChunk.usage.cacheWriteTokens ?? 0), 9603);
  assert.equal(usageChunk.usage.outputTokens, 389);
} finally {
  await scaledAdapter.close();
}

console.log("gravity adapter: ok");

// fitPrompt keeps the system part and the newest messages, and says what it left out.
{
  const big = "x".repeat(400);
  const parts = ["system: s", ...Array.from({ length: 10 }, (_, i) => `m${i} ${big}`)];
  const all = fitPrompt(parts, true, 100_000);
  assert.equal(all.dropped, 0);
  assert.equal(all.text, parts.join("\n\n"));
  const some = fitPrompt(parts, true, 1500);
  assert.ok(some.dropped > 0 && some.text.startsWith("system: s\n\n[") && some.text.includes("left out"));
  assert.ok(some.text.endsWith(`m9 ${big}`)); // the newest survives
  assert.ok(!some.text.includes(`m0 ${big}`)); // the oldest goes first
  assert.ok(Buffer.byteLength(JSON.stringify(some.text)) <= 1500);
  // One message bigger than the whole budget is cut to its tail rather than refused.
  const only = fitPrompt(["a".repeat(5000) + "END"], false, 1000);
  assert.ok(only.text.endsWith("END") && Buffer.byteLength(JSON.stringify(only.text)) <= 1000);
}
console.log("fitPrompt: ok");
