import assert from "node:assert/strict";
import type { SessionEvent, Session } from "./dsh.js";
import { gravityToolRows } from "./gravity-tool-rows.js";

const logged: Array<{ type: string; data: unknown; opts: unknown }> = [];
const event = (type: string, data: SessionEvent["data"], seq: number): SessionEvent => ({ type, data, seq, time: 0 });
const events = [event("turn/start", { turn: 1 }, 1), event("step/start", { turn: 1, step: 0 }, 2)];
const host = {
  header: { version: 4 },
  snapshotEvents: () => events,
  append(type, data, opts) {
    logged.push({ type, data, opts });
    return event(type, data, logged.length + 2);
  },
} satisfies Pick<Session, "snapshotEvents" | "append"> & { header: { version: number } };
const rows = gravityToolRows(host, "antigravity", "default");
assert.ok(rows);
const start = { sessionUpdate: "tool_call", toolCallId: "read-1", name: "read_file", title: "Reading fixture", rawInput: { path: "fixture.txt" } };
rows.update(start);
rows.update(start);
rows.update({ sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "marker" } }] });
rows.update({ sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "failed" });
rows.update({ ...start, toolCallId: "read-2" });
rows.finish();
rows.update({ ...start, toolCallId: "late" });
rows.finish();
assert.deepEqual(logged.map((row) => row.type), ["assistant/message", "tool/call", "tool/result", "assistant/message", "tool/call", "tool/result"]);
const call = logged[1]?.data as { turn: number; step: number; callId: string; name: string; arguments: string };
assert.deepEqual({ ...call, callId: "redacted" }, { turn: 1, step: 0, callId: "redacted", name: "agy:read_file", arguments: '{"path":"fixture.txt"}' });
assert.equal(rows.callId("read-1"), call.callId);
assert.deepEqual(logged[2]?.opts, { surfaceOp: "append", sourceEventSeqs: [4] });
const result = logged[2]?.data as { message: { role: string; toolCallId: string } };
assert.equal(result.message.role, "tool");
assert.equal(result.message.toolCallId, call.callId);
assert.match(JSON.stringify(result), /marker/);
assert.match(JSON.stringify(logged[5]?.data), /ended without reporting a result/);
events.push(event("step/end", { turn: 1, step: 0 }, 10));
assert.equal(gravityToolRows(host, "antigravity", "default"), undefined);
console.log("gravity tool rows: ok");
