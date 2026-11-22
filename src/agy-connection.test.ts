import assert from "node:assert/strict";
import { AgyConnection } from "./agy-connection.js";

// Fake only the external CLI. Drive the real pipe, parser and bidirectional RPC.
const fixture = String.raw`
const readline = require('node:readline');
const send = m => console.log(JSON.stringify({jsonrpc:'2.0', ...m}));
let seq = 0, pending;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    if (m.params.protocolVersion !== 1) process.exit(4);
    send({id:m.id, result:{protocolVersion:1}});
  } else if (m.method === 'session/new') {
    if (m.params.cwd !== process.cwd() || m.params.mcpServers.length) process.exit(4);
    send({id:m.id,result:{sessionId:'same'}});
  } else if (m.method === 'session/prompt') {
    if (m.params.sessionId !== 'same') process.exit(4);
    const text = m.params.prompt[0].text;
    if (text === 'disconnect') process.exit(24);
    if (text === 'malformed') { console.log('{not json}'); return; }
    if (text === 'permission') {
      pending = m.id;
      send({id:'agent-1',method:'session/request_permission',params:{sessionId:'same',options:[{optionId:'deny',kind:'reject_once'}]}});
      return;
    }
    if (text === 'hang') { pending = m.id; return; }
    if (text === 'auth') { send({id:m.id, error:{code:-32000, message:'Authentication required'}}); return; }
    if (text === 'big' || text === 'huge') {
      const n = text === 'big' ? 3e6 : 40e6;
      // One write: a big pipe write is not atomic with a following console.log.
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'same',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'x'.repeat(n)}}}})+'\n'+JSON.stringify({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}})+'\n');
      return;
    }
    const update = JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'same',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'turn '+(++seq)+' '+text}}}})+'\n';
    process.stdout.write(update.slice(0, 19));
    setImmediate(() => { process.stdout.write(update.slice(19)); send({id:m.id,result:{stopReason:'end_turn'}}); });
  } else if (m.method === 'session/cancel') {
    if ('id' in m || m.params.sessionId !== 'same' || !pending) process.exit(4);
    send({id:pending,result:{stopReason:'cancelled'}});
  } else if (m.id === 'agent-1') {
    if (m.result?.outcome?.outcome !== 'cancelled') process.exit(4);
    send({id:pending,result:{stopReason:'end_turn'}});
  } else process.exit(4);
});`;
const options = { command: process.execPath, args: ["-e", fixture], cwd: process.cwd(), env: process.env, timeoutMs: 3000 };
const messages: string[] = [];
const connection = new AgyConnection(options, (method, params) => {
  if (method === "session/update") {
    const update = params.update as { content: { text: string } };
    messages.push(update.content.text);
  }
});
const init = { protocolVersion: 1, clientCapabilities: {} };
const makePrompt = (text: string) => ({ sessionId: "same", prompt: [{ type: "text", text }] });
try {
  assert.deepEqual(await connection.request("initialize", init), { protocolVersion: 1 });
  assert.deepEqual(await connection.request("session/new", { cwd: options.cwd, mcpServers: [] }), { sessionId: "same" });
  for (const text of ["alpha", "beta", "gamma"]) {
    assert.deepEqual(await connection.request("session/prompt", makePrompt(text)), { stopReason: "end_turn" });
  }
  assert.deepEqual(messages, ["turn 1 alpha", "turn 2 beta", "turn 3 gamma"]);
  assert.deepEqual(await connection.request("session/prompt", makePrompt("permission")), { stopReason: "end_turn" });
  const active = connection.request("session/prompt", makePrompt("hang"));
  connection.notify("session/cancel", { sessionId: "same" });
  assert.deepEqual(await active, { stopReason: "cancelled" });
  // An expired sign-in is named plainly, not left as a bare -32000 code.
  await assert.rejects(connection.request("session/prompt", makePrompt("auth")), /sign-in required.*run `agy`.*Authentication required/);
  await assert.rejects(connection.request("session/prompt", makePrompt("disconnect")), /exited.*24/);
} finally {
  await connection.close();
}

const stalled = new AgyConnection({ ...options, timeoutMs: 500 });
try {
  await assert.rejects(stalled.request("session/prompt", makePrompt("hang")), /timed out/);
  await assert.rejects(stalled.request("initialize", init), /closed|timed out/);
} finally {
  await stalled.close();
}
const input = new AgyConnection(options);
try {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await assert.rejects(input.request("initialize", cyclic), /outgoing frame is not JSON/);
  assert.deepEqual(await input.request("initialize", init), { protocolVersion: 1 });
  await assert.rejects(input.request("session/prompt", makePrompt("malformed")), /invalid JSON-RPC/);
  assert.equal(input.closed, true);
} finally {
  await input.close();
}
// A large tool result or long command output is one big frame; it must not kill the turn (AGY is the user's own CLI).
const big = new AgyConnection(options, (method, params) => {
  if (method === "session/update") messages.push((params.update as { content: { text: string } }).content.text.length.toString());
});
try {
  await big.request("initialize", init);
  await big.request("session/new", { cwd: options.cwd, mcpServers: [] });
  assert.deepEqual(await big.request("session/prompt", makePrompt("big"), 20000), { stopReason: "end_turn" });
  assert.ok(messages.includes("3000000"));
  // Still bounded: a frame beyond the cap (here 40 MB) fails the connection instead of exhausting memory.
  await assert.rejects(big.request("session/prompt", makePrompt("huge"), 20000), /size limit|closed|exited/);
} finally {
  await big.close();
}
console.log("agy connection: ok");
