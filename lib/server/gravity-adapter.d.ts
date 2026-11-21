import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { AgyConnection } from "./agy-connection.js";
import type { ResumeMap } from "./gravity-store.js";
import type { McpServerConfig } from "./gravity-mcp.js";
import type { ApprovalOutcome, SessionId } from "./dsh.js";
import type { gravityToolRows } from "./gravity-tool-rows.js";
type ConnectionOptions = ConstructorParameters<typeof AgyConnection>[0];
/** `models`: ids the picker offers (empty or absent: all). `hidden`: ids the Settings page currently hides. */
type LaunchOptions = Omit<ConnectionOptions, "cwd" | "timeoutMs"> & {
    models?: readonly string[];
    hidden?: () => readonly string[];
    /** Launch args used when DSH access is `danger-full-access` (e.g. `["acp", "--dangerously-skip-permissions"]`). */
    fullAccessArgs?: readonly string[];
    /** Where the last good model list is kept, so a restart or a failed AGY start still shows models. */
    catalogFile?: string;
    /** How long a model list counts as fresh; a stale one is still answered at once and refreshed behind. */
    catalogTtlMs?: number;
    /** AGY's conversation store; a throwaway probe session's empty conversation is removed from it. Defaults to AGY's own location. */
    conversationsDir?: string;
    /** A session's AGY process (about 240 MB) is stopped after this long idle, and at most `maxProcesses` stay alive; the conversation resumes by session/load. */
    idleMs?: number;
    reapEveryMs?: number;
    maxProcesses?: number;
    log?: (message: string) => void;
};
type Fields = Record<string, unknown>;
type McpGrant = {
    config: McpServerConfig;
    revoke(): void;
    ownsTool?: (tool: string) => boolean;
};
type Catalog = {
    id: string;
    name: string;
}[];
/** Context windows AGY 1.5.13 reported (usage_update.size) per model family; used until a turn reports the real one. Unknown models get a small window so DSH compacts early rather than late. */
export declare function contextFallback(model: string): number;
export type GravityApproval = (request: {
    sessionId: SessionId;
    callId: string;
    toolName: string;
    reason: string;
    signal: AbortSignal;
}) => Promise<ApprovalOutcome>;
export type ToolCallMeta = {
    title?: string;
    kind?: string;
    rawInput?: unknown;
    locations?: unknown[];
};
/** Builds a human- and Auto-Review-readable explanation from permission/tool-call metadata. */
export declare function describePermission(toolName: string, call: Fields | undefined, prev?: ToolCallMeta): string;
export declare const GRAVITY_PROVIDER = "antigravity";
/** ACP-backed provider. AGY owns execution; only explicit, one-time host approvals are relayed. */
export declare class GravityAdapter extends LlmAdapter {
    private readonly launch;
    private readonly cwdFor;
    private readonly approve?;
    private readonly resume?;
    private readonly toolRows?;
    private readonly mcp?;
    private readonly sessions;
    private readonly living;
    private disposed;
    /** DSH's access mode as of each keyed session's latest turn. */
    private readonly access;
    private readonly lastLogged;
    /** Context windows AGY reported during turns, by model id (and by its level-free id). shortcut: not kept across restarts; the family table covers that. */
    private readonly contexts;
    private catalog?;
    constructor(launch: LaunchOptions, cwdFor: (sessionId: GenerateOptions["sessionId"]) => string | undefined, approve?: GravityApproval | undefined, resume?: ResumeMap | undefined, toolRows?: ((id: SessionId, model: string) => ReturnType<typeof gravityToolRows>) | undefined, mcp?: ((sessionId: string) => Promise<McpGrant | undefined>) | undefined);
    providerInfo(provider: string): {
        id: string;
        name: string;
    };
    private probing?;
    private reaper?;
    private probeConn?;
    private diskRead;
    /** One throwaway AGY session, only to read its model list. */
    private probeOnce;
    /**
     * AGY keeps every session/new as a conversation file (~400 KB) in its history, and ACP has no way to delete one. A probe session is
     * never prompted, so its conversation is empty and ours alone: remove it, by an id that is checked to be a plain id, never a path.
     */
    private forgetEmpty;
    /** Stops a session's AGY process; its conversation stays and resumes by session/load on the next turn. */
    private evict;
    private reap;
    /** Makes room for one more process: the longest-idle quiet sessions go first. */
    private makeRoom;
    /** How many AGY processes serve sessions right now. */
    processCount(): number;
    /** One refresh at a time, however many callers ask; a failed start is tried once more. Never throws. */
    private refresh;
    /** The last good list from disk, treated as stale so it is refreshed at once. */
    private readDisk;
    /**
     * AGY's model list, one entry per model (levels folded). A list we already hold is answered at once, and when stale refreshed
     * behind the caller, so the picker never waits on a cold AGY start; only the very first request, or `force`, waits.
     * `answered` says whether AGY itself replied just now. The list is empty when AGY has never answered.
     */
    private shownModels;
    listModels(provider: string): Promise<{
        provider: string;
        id: string;
        name: string;
    }[]>;
    /**
     * For the Settings page, before any hiding. `fresh` asks AGY anew (which only answers a session request when signed in);
     * without it the page opens from the list already held, which says nothing new about sign-in but takes no AGY start.
     */
    catalogStatus({ fresh }: {
        fresh: boolean;
    }): Promise<{
        signedIn: boolean;
        models: Catalog;
        plan?: string;
    }>;
    resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    private open;
    private release;
    /** DSH's access mode as of this session's latest turn, for the tool bridge. */
    accessOf(sessionId: string): string | undefined;
    close(): Promise<void>;
    stream(options: GenerateOptions): AsyncGenerator<StreamChunk>;
}
export {};
