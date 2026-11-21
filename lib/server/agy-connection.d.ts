interface ConnectionOptions {
    command: string;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
}
type Fields = Record<string, unknown>;
type AgentHandler = (method: string, params: Fields, request: boolean) => unknown;
/** One bounded NDJSON JSON-RPC connection to an AGY subprocess. */
export declare class AgyConnection {
    private readonly options;
    private readonly onAgentMessage?;
    private readonly child;
    private readonly exited;
    private readonly pending;
    private buffer;
    private nextId;
    private failure?;
    private closing?;
    constructor(options: ConnectionOptions, onAgentMessage?: AgentHandler | undefined);
    get closed(): boolean;
    request(method: string, params: Fields, timeoutMs?: number): Promise<unknown>;
    notify(method: string, params: Fields): void;
    close(): Promise<void>;
    private fail;
    private send;
    private read;
    private route;
}
export {};
