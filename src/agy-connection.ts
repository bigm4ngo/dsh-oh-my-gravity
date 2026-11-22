import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

interface ConnectionOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

type Fields = Record<string, unknown>;
type AgentHandler = (method: string, params: Fields, request: boolean) => unknown;
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};
/** Outgoing frames are our own prompts: small. Incoming ones carry whole tool results (a file read, command output), so the cap is generous. */
const MAX_OUT = 1024 * 1024;
const MAX_IN = 32 * 1024 * 1024;
const CANCELLED = { outcome: { outcome: "cancelled" } };

function encode(message: Fields): string {
  let encoded: string;
  try {
    encoded = JSON.stringify({ jsonrpc: "2.0", ...message });
  } catch {
    throw new Error("AGY ACP outgoing frame is not JSON");
  }
  if (Buffer.byteLength(encoded) > MAX_OUT) {
    throw new Error("AGY ACP outgoing frame exceeds size limit");
  }
  return `${encoded}\n`;
}

function fields(value: unknown): Fields | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
}

/** One bounded NDJSON JSON-RPC connection to an AGY subprocess. */
export class AgyConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<void>;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private nextId = 0;
  private failure?: Error;
  private closing?: Promise<void>;

  constructor(
    private readonly options: ConnectionOptions,
    private readonly onAgentMessage?: AgentHandler,
  ) {
    this.child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env });
    this.exited = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        this.fail(new Error(`AGY ACP exited (${signal ?? code ?? "unknown"})`));
        resolve();
      });
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    // Consume diagnostics so the child cannot block on stderr; never forward private log data.
    this.child.stderr.resume();
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.read(chunk));
  }

  get closed(): boolean {
    return this.failure !== undefined;
  }

  request(method: string, params: Fields, timeoutMs = this.options.timeoutMs): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    let encoded: string;
    try {
      encoded = encode({ id, method, params });
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`AGY ACP ${method} timed out`));
        void this.close();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(encoded);
    });
  }

  notify(method: string, params: Fields): void {
    this.send({ method, params });
  }

  close(): Promise<void> {
    this.fail(new Error("AGY ACP connection closed"));
    return (this.closing ??= (async () => {
      this.child.stdin.end();
      const force = setTimeout(() => this.child.kill("SIGKILL"), 1000);
      try {
        await this.exited;
      } finally {
        clearTimeout(force);
      }
    })());
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private send(message: Fields): void {
    if (this.failure) return;
    try {
      this.child.stdin.write(encode(message));
    } catch (error) {
      this.fail(error as Error);
      void this.close();
    }
  }

  private read(chunk: string): void {
    if (this.failure) return;
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_IN) break;
      if (!line.trim()) continue;
      try {
        const frame = fields(JSON.parse(line));
        if (!frame || frame.jsonrpc !== "2.0") throw new Error("invalid envelope");
        this.route(frame);
      } catch {
        this.fail(new Error("AGY ACP sent an invalid JSON-RPC frame"));
        void this.close();
        return;
      }
      if (this.failure) return;
    }
    if (end !== -1 || Buffer.byteLength(this.buffer) > MAX_IN) {
      this.fail(new Error("AGY ACP incoming frame exceeds size limit"));
      void this.close();
    }
  }

  private route(frame: Fields): void {
    const { method, id } = frame;
    if (typeof method === "string") {
      const params = fields(frame.params) ?? {};
      if (!("id" in frame)) {
        this.onAgentMessage?.(method, params, false);
        return;
      }
      if (typeof id !== "string" && typeof id !== "number") return;
      // Only the permission callback is implemented. Do not execute arbitrary agent requests.
      if (method !== "session/request_permission") {
        this.send({ id, error: { code: -32601, message: "Method not supported" } });
        return;
      }
      void Promise.resolve()
        .then(() => this.onAgentMessage?.(method, params, true))
        .then((result) => this.send({ id, result: result ?? CANCELLED }), () => {
          this.send({ id, result: CANCELLED });
        });
      return;
    }
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if ("result" in frame && !("error" in frame)) pending.resolve(frame.result);
    else {
      const error = fields(frame.error);
      const code = typeof error?.code === "number" ? error.code : undefined;
      const detail = typeof error?.message === "string" && error.message.trim() ? error.message.trim() : undefined;
      // AGY's "Authentication required" is the sign-in expiring, not a plugin fault: say so plainly instead of a bare code.
      if (detail && /authentication required|not signed in/i.test(detail)) {
        pending.reject(new Error(`Antigravity sign-in required — run \`agy\` in a terminal to sign in (AGY said: ${detail})`));
        return;
      }
      const suffix = detail ? ` (${code !== undefined ? `${code}: ` : ""}${detail})` : code !== undefined ? ` (${code})` : "";
      pending.reject(new Error(`AGY ACP request failed${suffix}`));
    }
  }
}
