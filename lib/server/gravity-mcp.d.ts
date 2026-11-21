import type { Agent, ApprovalOutcome, DshToolsRegistry, JsonValue } from "./dsh.js";
export declare const KEY_HEADER = "x-gravity-key";
export interface McpServerConfig {
    type: "http";
    name: "dsh";
    url: string;
    headers: {
        name: string;
        value: string;
    }[];
}
export interface ToolBridge {
    url: string;
    /** A per-session credential: AGY gets the config, and calls reach only that session's agent. */
    issue(sessionId: string): {
        config: McpServerConfig;
        revoke(): void;
    };
    close(): Promise<void>;
}
export type BridgeApproval = (sessionId: string, tool: string, args: Record<string, JsonValue>, signal: AbortSignal) => Promise<ApprovalOutcome>;
/** Serves the DSH tools an agent can see to AGY over MCP Streamable HTTP on loopback. Tools run
 *  here, inside DSH; AGY asks DSH's approval for each call before it reaches this server. */
export declare function startToolBridge(tools: Pick<DshToolsRegistry, "schemas" | "get">, agentFor: (sessionId: string) => Agent | undefined, approve: BridgeApproval, 
/** A reason this tool may not run in this session right now (DSH has it read-only), or undefined. */
refuse?: (sessionId: string, tool: string) => string | undefined): Promise<ToolBridge>;
