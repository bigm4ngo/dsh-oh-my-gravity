import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserMessage, type GenerateOptions } from "@deepseek-ai/dsh-llm";
import { contextFallback, GravityAdapter } from "./gravity-adapter.js";

// Fake AGY: models m-a, m-b and g at low/high; set_model recorded; each reply names the serving model.
const script = String.raw`
const send = m => console.log(JSON.stringify({jsonrpc:'2.0',...m}));
let current = 'm-a', sets = 0;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({id:m.id,result:{protocolVersion:1}});
  if (m.method === 'session/new') return send({id:m.id,result:{sessionId:'s',models:{currentModelId:'m-a',availableModels:[{modelId:'m-a',name:'Model A'},{modelId:'m-b',name:'Model B'},{modelId:'g-low',name:'G (Low)'},{modelId:'g-high',name:'G (High)'},{modelId:'g-xhigh',name:'G (XHigh)'}]}}});
  if (m.method === 'session/set_model') { current = m.params.modelId; sets++; return send({id:m.id,result:{}}); }
  if (m.method === 'session/prompt') {
    send({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'usage_update',used:5,size: current.startsWith('g') ? 7777 : 4242}}});
    send({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:current+' sets='+sets}}}});
    send({id:m.id,result:{stopReason:'end_turn'}});
  }
});`;
const launch = { command: process.execPath, args: ["-e", script], env: process.env };
const adapter = new GravityAdapter(launch, () => process.cwd());
const ask = (model: string, effort?: string): GenerateOptions => ({
  provider: "antigravity", model, sessionId: "s" as GenerateOptions["sessionId"],
  messages: [createUserMessage({ content: [{ type: "text", text: "hi" }], source: { kind: "user" } })],
  ...(effort ? { reasoningEffort: effort as never } : {}),
});
async function said(model: string, effort?: string) {
  let text = "";
  for await (const c of adapter.stream(ask(model, effort))) if (c.type === "text-delta") text += c.text;
  return text;
}
try {
  // One entry for a model AGY ships at several levels; the level is the effort chooser's job.
  assert.deepEqual((await adapter.listModels("antigravity")).map(({ id, name }) => [id, name]),
    [["default", "Antigravity CLI default"], ["m-a", "Model A"], ["m-b", "Model B"], ["g", "G"]]);
  const g = await adapter.resolveModel("antigravity", "g");
  assert.deepEqual(g.reasoning?.efforts.map((e) => [e.id as string, e.name]), [["low", "Low"], ["high", "High"], ["xhigh", "XHigh"]]);
  assert.equal(g.reasoning?.defaultEffort as string, "high");
  assert.equal((await adapter.resolveModel("antigravity", "m-a")).reasoning, undefined);

  // DSH will not switch to a model without a context window: a family default until AGY reports the real one in a turn.
  assert.equal((await adapter.resolveModel("antigravity", "m-a")).context?.contextWindow, 128_000);
  assert.equal((await adapter.resolveModel("antigravity", "g")).context?.contextWindow, 128_000);
  assert.equal(await said("default"), "m-a sets=0");
  assert.equal(await said("m-b"), "m-b sets=1");
  assert.equal(await said("m-b"), "m-b sets=1"); // unchanged model: no second switch
  assert.equal(await said("default"), "m-a sets=2"); // default restores AGY's own choice
  assert.equal(await said("g", "low"), "g-low sets=3");
  assert.equal((await adapter.resolveModel("antigravity", "g")).context?.contextWindow, 7777); // learned from the turn, shared by every level
  assert.equal((await adapter.resolveModel("antigravity", "m-a")).context?.contextWindow, 4242);
  assert.equal(await said("g", "low"), "g-low sets=3");
  assert.equal(await said("g", "xhigh"), "g-xhigh sets=4");
  assert.equal(await said("g", "high"), "g-high sets=5");
  assert.equal(await said("g"), "g-high sets=5"); // no effort: AGY's own level
  assert.equal(await said("g-low"), "g-low sets=6"); // a full variant id still works
  await assert.rejects(said("g", "medium"), /does not offer model g-medium/);
  await assert.rejects(said("nope"), /does not offer model nope/);
} finally {
  await adapter.close();
}

// `models` limits what the picker offers; `default` always stays, and requests are not refused for being unlisted.
const limited = new GravityAdapter({ ...launch, models: ["g", "m-b"] }, () => process.cwd());
try {
  assert.deepEqual((await limited.listModels("antigravity")).map((m) => m.id), ["default", "m-b", "g"]);
} finally {
  await limited.close();
}
// What AGY 1.5.13 was seen to report (usage_update.size), used until a turn teaches the real value.
assert.deepEqual(["gemini-4-hydrogen", "gemini-3.8-flash", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-oss-120b-medium", "something-new"].map(contextFallback),
  [1_048_576, 1_048_576, 1_000_000, 1_000_000, 131_072, 128_000]);

// The Settings page hides models live; `models` (profile) and `hidden` (page) both apply, and a hidden model still runs.
let hidden = ["m-a"];
const both = new GravityAdapter({ ...launch, hidden: () => hidden }, () => process.cwd());
try {
  assert.deepEqual((await both.listModels("antigravity")).map((m) => m.id), ["default", "m-b", "g"]);
  hidden = ["m-b", "g"];
  assert.deepEqual((await both.listModels("antigravity")).map((m) => m.id), ["default", "m-a"]);
  // The page's own view is unfiltered, and says whether AGY answered.
  const seen = await both.catalogStatus({ fresh: true });
  assert.equal(seen.signedIn, true);
  assert.deepEqual(seen.models.map((m) => m.id), ["m-a", "m-b", "g"]);
} finally {
  await both.close();
}
// A failed forced check reports "not signed in" without wiping the picker's last good list.
const flaky = join(mkdtempSync(join(tmpdir(), "gravity-flaky-")), "down");
const flakyAdapter = new GravityAdapter({ ...launch, args: ["-e", `if (require('fs').existsSync(${JSON.stringify(flaky)})) process.exit(3);` + script] }, () => process.cwd());
try {
  assert.equal((await flakyAdapter.listModels("antigravity")).length, 4);
  writeFileSync(flaky, "");
  const failed = await flakyAdapter.catalogStatus({ fresh: true });
  assert.equal(failed.signedIn, false);
  assert.deepEqual(failed.models.map((m) => m.id), ["m-a", "m-b", "g"]);
  assert.equal((await flakyAdapter.listModels("antigravity")).length, 4);
} finally {
  await flakyAdapter.close();
}
const dead = new GravityAdapter({ command: process.execPath, args: ["-e", "process.exit(3)"], env: process.env }, () => process.cwd());
try {
  assert.deepEqual(await dead.catalogStatus({ fresh: true }), { signedIn: false, models: [] });
} finally {
  await dead.close();
}
console.log("gravity models: ok");
