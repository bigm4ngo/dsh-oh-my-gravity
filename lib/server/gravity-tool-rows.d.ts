import { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { Session } from "./dsh.js";
type Ledger = Pick<Session, "snapshotEvents" | "append"> & {
    header: Pick<Session["header"], "version">;
};
/** Records AGY-owned activity, without emitting executable LLM tool-call chunks. */
export declare function gravityToolRows(session: Ledger, provider: string, model: string): {
    callId: (remoteId: string) => ToolCallId | undefined;
    update(value: unknown): void;
    finish(): void;
} | undefined;
export {};
