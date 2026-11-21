import type { Agent, DshToolsRegistry } from "./dsh.js";
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
export interface ToolGrant {
    config: McpServerConfig;
    revoke(): void;
    ownsTool(tool: string): boolean;
}
export interface ToolBridge {
    url: string;
    /** A per-session credential: AGY gets the config, and calls reach only that session's agent. */
    issue(sessionId: string): ToolGrant;
    close(): Promise<void>;
}
/** Serves the DSH tools an agent can see to AGY over MCP Streamable HTTP on loopback.
 *  Tools enforce their own permissions inside DSH; the adapter enforces the read-only plan gate. */
export declare function startToolBridge(tools: Pick<DshToolsRegistry, "schemas" | "get">, agentFor: (sessionId: string) => Agent | undefined, 
/** A reason this tool may not run in this session right now (DSH has it read-only), or undefined. */
refuse?: (sessionId: string, tool: string) => string | undefined): Promise<ToolBridge>;
