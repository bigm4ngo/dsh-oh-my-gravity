import { randomUUID } from "node:crypto";
import { createAssistantMessage, ToolCallId } from "@deepseek-ai/dsh-llm";
import type { JsonValue, Session } from "./dsh.js";
import { toolResultMessage } from "./rows-probe.js";

type Ledger = Pick<Session, "snapshotEvents" | "append"> & { header: Pick<Session["header"], "version"> };
type Call = { id: ReturnType<typeof ToolCallId>; seq: number; settled: boolean };

function openStep(session: Ledger) {
  const boundary = session.snapshotEvents().findLast(({ type }) =>
    type === "step/start" || type === "step/end" || type === "turn/end" || type === "turn/start");
  const turn = boundary?.data.turn;
  const step = boundary?.data.step;
  if (boundary?.type === "step/start" && typeof turn === "number" && typeof step === "number") {
    return { turn, step };
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function resultText(update: Record<string, unknown>) {
  const text: string[] = [];
  if (Array.isArray(update.content)) {
    for (const block of update.content) {
      const nested = record(record(block)?.content);
      if (nested?.type === "text" && typeof nested.text === "string") text.push(nested.text);
    }
  }
  if (text.length) return text.join("\n").slice(0, 16_384);
  return update.status === "completed" ? "AGY reported completion." : "AGY reported failure.";
}

/** Records AGY-owned activity, without emitting executable LLM tool-call chunks. */
export function gravityToolRows(session: Ledger, provider: string, model: string) {
  const step = openStep(session);
  if (!step) return;
  const calls = new Map<string, Call>();
  let finished = false;

  const settle = (call: Call, text: string, isError: boolean) => {
    if (call.settled) return;
    const message = toolResultMessage(session.header.version, call.id, randomUUID(), text, isError);
    session.append("tool/result", { ...step, message }, {
      surfaceOp: "append", sourceEventSeqs: [call.seq],
    });
    call.settled = true;
  };

  return {
    callId: (remoteId: string) => calls.get(remoteId)?.id,
    update(value: unknown) {
      if (finished) return;
      const frame = record(value);
      const remoteId = frame?.toolCallId;
      if (!frame || typeof remoteId !== "string" || !remoteId || remoteId.length > 256) return;
      let call = calls.get(remoteId);
      if (!call && frame.sessionUpdate === "tool_call" && calls.size < 128) {
        const id = ToolCallId(randomUUID());
        const toolName = typeof frame.name === "string" && /^[\w.-]{1,80}$/.test(frame.name) ? frame.name : "tool";
        const name = `agy:${toolName}`;
        const raw = JSON.stringify(frame.rawInput ?? {});
        const args = raw.length <= 8192 ? raw : '{"omitted":"AGY arguments exceeded the display limit"}';
        const message = createAssistantMessage({ source: { provider, model }, content: [
          { type: "tool-call", id, name, arguments: args },
        ] });
        session.append("assistant/message", { ...step, message: message as unknown as JsonValue, stream: [] }, { surfaceOp: "append" });
        const event = session.append("tool/call", { ...step, callId: id, name, arguments: args });
        call = { id, seq: event.seq, settled: false };
        calls.set(remoteId, call);
      }
      if (call && (frame.sessionUpdate === "tool_call_update" || frame.sessionUpdate === "tool_call") &&
          (frame.status === "completed" || frame.status === "failed")) {
        settle(call, resultText(frame), frame.status === "failed");
      }
    },
    finish() {
      if (finished) return;
      for (const call of calls.values()) settle(call, "AGY ended without reporting a result for this call.", true);
      finished = true;
    },
  };
}
