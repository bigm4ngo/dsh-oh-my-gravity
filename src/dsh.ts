// The slice of the DeepSeek Harness (dsh) service surface this plugin actually touches. The dsh
// packages are not dependencies here; these shapes were read off the installed service type files
// and narrowed to what this plugin calls.

import type { ContentBlock, GenerateOptions, Message } from "@deepseek-ai/dsh-llm";

/** A dsh session id, branded the way dsh-llm brands the one carried on a request. */
export type SessionId = NonNullable<GenerateOptions["sessionId"]>;

/** A JSON document: tool arguments, relay payloads and similar. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Session ids cross the wire as plain strings; this is where a string becomes a branded id. */
export const asSessionId = (id: string): SessionId =>
  // SAFETY: the brand only records provenance; every id here came from dsh itself.
  id as SessionId;

/** A session's identity line. */
export interface SessionHeader {
  readonly version: number;
  readonly id: SessionId;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: SessionId;
  readonly isSeeded: boolean;
  readonly origin?: "subagent";
  readonly delegationDepth?: number;
  readonly agentPreset?: string;
}

/** One durable session event. */
export interface SessionEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, JsonValue>;
  surfaceOp?: "append";
  sourceEventSeqs?: number[];
}

/** A live session and the log operations this plugin drives. */
export interface Session {
  readonly header: SessionHeader;
  readonly id: SessionId;
  readonly firstLiveSeq: number;
  /** Kept for older callers; dsh marks it deprecated but still accepts it. */
  snapshotEvents(fromSeq?: number, toSeqExclusive?: number): readonly SessionEvent[];
  isOwnSeq(seq: number): boolean;
  get seq(): number;
  append<T extends string>(
    type: T,
    data: Record<string, JsonValue>,
    ...opts: unknown[]
  ): SessionEvent;
  deriveMessages(): Message[];
  /** The folded request header; `tools` is what the next step offers the model. */
  requestHeader():
    | {
        version: number;
        config?: { provider?: string; model?: string };
        readonly tools?: readonly ToolSchema[];
      }
    | undefined;
  requestContext(): { provider?: string; model?: string } | undefined;
}

/** A model route: provider, model, and an optional reasoning effort. */
export interface ModelRoute {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** A live dsh agent, narrowed to what the provider adapter reads and writes. */
export interface Agent {
  readonly id: SessionId;
  readonly session?: Session;
  /** The agent's own selector for the next step's route. */
  readonly model?: {
    select(selection: ModelRoute): void;
    current(): ModelRoute | undefined;
  };
  ctx?: PluginContext;
  followup(message: Message): void;
  /** dsh-agent-loop's current phase, on agents that have one. */
  readonly status?: string;
  /** Queue a message for the running turn (or open one when idle). */
  steer?(message: Message): void;
  /** Abort the running turn; `keepInbox` keeps queued and steering messages. */
  cancel?(cause: { kind: "user" }, options?: { keepInbox?: boolean }): void;
  /** Resolves once no turn or maintenance task is running. */
  whenIdle?(): Promise<void>;
  /** Pending input for the loop. `replace`/`remove` answer false once the message is gone. */
  readonly inbox?: {
    readonly nextStep: readonly Message[];
    readonly nextTurn?: readonly Message[];
    replace(messageId: string, message: Message): boolean;
    remove(messageId: string): boolean;
  };
}

/** A tool's advertised schema. */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, JsonValue>;
  /** Defer loading the definition until the tool is surfaced. */
  deferLoading?: true;
}

/** What one tool execution receives. */
export interface ToolExec {
  agent: Agent;
  signal: AbortSignal;
  name: string;
  arguments: Record<string, JsonValue>;
  callId: string;
}

/** A registered tool as the bridge drives it: execute, then render if it renders. */
export interface DshTool {
  execute(args: Record<string, JsonValue>, exec: ToolExec): Promise<JsonValue>;
  output?: { render?: (args: Record<string, JsonValue>, returned: JsonValue) => JsonValue };
}

/** The tool registry: what is advertised, and how to run it. */
export interface DshToolsRegistry {
  schemas(agent: Agent): ToolSchema[];
  get(name: string, agent: Agent): DshTool | undefined;
}

/** The closed set of approval answers. Only `allowed-once` grants. */
export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

/** One approval question put to the user. */
export interface ApprovalRequest {
  readonly agent: Agent;
  readonly toolName: string;
  readonly callId?: string;
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

/** The plugin's dsh context, narrowed to the services this plugin uses. */
export interface PluginContext {
  llm: {
    registerConfigurableProviders: (
      providers: Array<{
        provider: string;
        displayName: string;
        settingsNs: string;
        settingsPath: string[];
      }>,
    ) => import("@deepseek-ai/dsh-llm").DirectoryRegistrationHandle;
    registerAdapter: (
      providers: string[],
      adapter: import("@deepseek-ai/dsh-llm").LlmAdapter,
    ) => import("@deepseek-ai/dsh-llm").AdapterRegistrationHandle;
  };
  sessions: { get(id: SessionId): Session | undefined };
  agents: { get(id: SessionId): Agent | undefined };
  approval: { request(req: ApprovalRequest): Promise<ApprovalOutcome> };
}
