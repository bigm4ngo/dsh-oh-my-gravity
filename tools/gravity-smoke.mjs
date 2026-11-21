// Run explicitly with an installed DSH and a signed-in AGY. Does not modify a DSH profile.
// Usage: node tools/gravity-smoke.mjs <absolute dsh package.json> [text|approval]
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as plugin from '../lib/server/gravity.js';

const [, , dshPackage, mode = 'text'] = process.argv;
assert.ok(dshPackage && isAbsolute(dshPackage) && ['text', 'approval', 'tools'].includes(mode),
  'usage: node tools/gravity-smoke.mjs <absolute dsh package.json> [text|approval|tools]');
const checkingApproval = mode !== 'text';
const bridging = mode === 'tools';
const executed = [];
const secret = `tangerine-${Math.floor(Math.random() * 1e6)}`;
const requireDsh = createRequire(dshPackage);
const load = (name) => import(pathToFileURL(requireDsh.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { LlmRuntime, createUserMessage } = await load('@deepseek-ai/dsh-llm');
const { Session, SessionId, SESSION_FORMAT_VERSION } = await load('@deepseek-ai/dsh-session');
const { SessionProjectionRegistry } = await load('@deepseek-ai/dsh-session-projection');
// AGY auto-allows reads under /tmp; set GRAVITY_SMOKE_DIR to a non-temp dir so approval mode triggers a real AGY ask.
const base = process.env.GRAVITY_SMOKE_DIR ?? tmpdir();
const root = await mkdtemp(join(base, 'gravity-dsh-smoke-'));
const cwd = join(root, 'workspace');
const id = 'gravity-smoke-session';
const answers = [];
const ctx = new Context();
const fibers = [];
let session;
let marker;
let userText = 'Reply with exactly: gravity-connected. Do not use any tools.';
async function mount(definition, config) {
  const fiber = ctx.plugin(definition, config);
  fibers.push(fiber);
  await fiber.await();
  return fiber;
}
try {
  await mount(LlmRuntime);
  await mkdir(cwd);
  session = Session.create(SessionId(id), [], { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd, isSeeded: false });
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 0 });
  await mount(SessionProjectionRegistry);
  if (checkingApproval) {
    const { ApprovalService } = await load('@deepseek-ai/dsh-user-approval');
    await mount(ApprovalService, { policy: 'ask' });
    if (bridging) {
      userText = 'Call the secret_word tool from the dsh MCP server exactly once and reply with the word it returns, nothing else. Use no other tool.';
      marker = secret;
    } else {
      const fixture = join(root, 'outside-fixture.txt');
      marker = randomUUID();
      await writeFile(fixture, marker);
      userText = `Use only your native file-read tool to read the synthetic fixture at ${fixture}. If permission is refused, do not retry and do not use any other tool. Never guess its contents.`;
    }
  }
  const agent = { id, session };
  await mount({ name: 'gravity-smoke-session', apply(host) {
    host.provide('sessions', { get: (requested) => requested === id ? session : undefined });
    if (checkingApproval) {
      host.provide('agents', { get: (requested) => requested === id ? agent : undefined });
      if (bridging) host.provide('tools', {
        schemas: () => [{ name: 'secret_word', description: 'Returns the secret word. Call it when asked for the secret word.', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
        get: (name) => name === 'secret_word' ? { execute: async (args, exec) => { executed.push(exec.agent === agent); return secret; } } : undefined,
      });
      host.on('approval/request', (request) => {
        answers.push({ exactSession: request.agent.session === session, callId: request.callId });
        return bridging ? 'allowed-once' : 'rejected';
      });
    }
  } });
  const fiber = await mount(plugin, {});
  assert.ok(ctx.llm.listProviders().some((provider) => provider.id === 'antigravity'));
  const messages = [createUserMessage({ content: [{ type: 'text', text: userText }], source: { kind: 'user' } })];
  const chunks = [];
  for await (const chunk of ctx.llm.stream({ provider: 'antigravity', model: 'default', sessionId: id, messages, signal: AbortSignal.timeout(120_000) })) chunks.push(chunk);
  const summary = {
    provider: 'antigravity',
    dsh: requireDsh(dshPackage).version,
    finish: chunks.at(-1)?.reason?.kind,
    code: chunks.at(-1)?.reason?.failure?.code,
    text: chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('').trim().slice(0, 200),
    textMatch: chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('').trim().toLowerCase().includes('gravity-connected'),
    usage: chunks.find((chunk) => chunk.type === 'usage')?.usage ?? null,
  };
  console.log(JSON.stringify(summary));
  assert.equal(summary.finish, 'stop');
  session.append('step/end', { turn: 1, step: 0 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const events = session.snapshotEvents();
  const asked = events.filter(({ type }) => type === 'approval/asked');
  const decided = events.filter(({ type }) => type === 'approval/decided');
  const calls = events.filter(({ type }) => type === 'tool/call');
  const results = events.filter(({ type }) => type === 'tool/result');
  const reply = chunks.filter(({ type }) => type === 'text-delta').map(({ text }) => text).join('');
  const rows = {
    asked: asked.length, decided: decided.length, answered: answers.length, calls: calls.length, results: results.length,
    denial: decided.every(({ data }) => data.outcome === (bridging ? 'allowed-once' : 'rejected')),
    markerAbsent: !marker || !reply.includes(marker),
    // With the DSH tool bridge there is also a bridge-side ask with no AGY tool row of its own.
    correlated: (bridging ? asked.some.bind(asked) : asked.every.bind(asked))(({ data }) => calls.some((call) => call.data.callId === data.callId)),
  };
  console.log(JSON.stringify(rows));
  assert.ok(summary.usage && summary.usage.inputTokens + summary.usage.outputTokens > 0, 'usage chunk must carry input and output tokens');
  if (checkingApproval) {
    assert.ok(calls.length > 0 && calls.length === results.length, 'AGY tool activity must be recorded as correlated DSH rows');
    if (bridging) {
      assert.deepEqual(executed, [true], 'the DSH tool must run exactly once, for this session\'s agent');
      assert.ok(reply.includes(marker), 'AGY must relay the DSH tool result');
    } else {
      assert.ok(answers.length > 0 && answers.every(({ exactSession }) => exactSession), 'the approval must belong to the smoke session');
      assert.ok(asked.length === answers.length && decided.length === answers.length && rows.denial, 'each AGY permission request must be answered as the mode dictates');
      assert.ok(rows.correlated, 'AGY tool activity must correlate with approval rows');
      assert.ok(rows.markerAbsent, 'the rejected read must not leak the fixture contents');
    }
    const restored = Session.create(SessionId(id), events, session.header);
    assert.ok(restored.snapshotEvents().length >= events.length, 'restore must keep every recorded event');
  } else {
    assert.ok(summary.textMatch, 'the live AGY reply must match the synthetic text');
  }
  await fiber.dispose();
  assert.ok(!ctx.llm.listProviders().some((provider) => provider.id === 'antigravity'));
  console.log('Gravity fiber disposed and provider unregistered');
} finally {
  try {
    for (const fiber of fibers.reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  } finally {
    // root is created by this process; verify before recursive cleanup.
    assert.ok(isAbsolute(root) && root.startsWith(join(base, 'gravity-dsh-smoke-')));
    await rm(root, { recursive: true, force: true });
    assert.ok(!process.getActiveResourcesInfo().includes('ProcessWrap'), 'a subprocess handle survived teardown');
  }
}
