import { spawn } from "node:child_process";
/** Outgoing frames are our own prompts: small. Incoming ones carry whole tool results (a file read, command output), so the cap is generous. */
const MAX_OUT = 1024 * 1024;
const MAX_IN = 32 * 1024 * 1024;
const CANCELLED = { outcome: { outcome: "cancelled" } };
function encode(message) {
    let encoded;
    try {
        encoded = JSON.stringify({ jsonrpc: "2.0", ...message });
    }
    catch {
        throw new Error("AGY ACP outgoing frame is not JSON");
    }
    if (Buffer.byteLength(encoded) > MAX_OUT) {
        throw new Error("AGY ACP outgoing frame exceeds size limit");
    }
    return `${encoded}\n`;
}
function fields(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
/** One bounded NDJSON JSON-RPC connection to an AGY subprocess. */
export class AgyConnection {
    options;
    onAgentMessage;
    child;
    exited;
    pending = new Map();
    buffer = "";
    nextId = 0;
    failure;
    closing;
    constructor(options, onAgentMessage) {
        this.options = options;
        this.onAgentMessage = onAgentMessage;
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
        this.child.stdout.on("data", (chunk) => this.read(chunk));
    }
    get closed() {
        return this.failure !== undefined;
    }
    request(method, params, timeoutMs = this.options.timeoutMs) {
        if (this.failure)
            return Promise.reject(this.failure);
        const id = ++this.nextId;
        let encoded;
        try {
            encoded = encode({ id, method, params });
        }
        catch (error) {
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
    notify(method, params) {
        this.send({ method, params });
    }
    close() {
        this.fail(new Error("AGY ACP connection closed"));
        return (this.closing ??= (async () => {
            this.child.stdin.end();
            const force = setTimeout(() => this.child.kill("SIGKILL"), 1000);
            try {
                await this.exited;
            }
            finally {
                clearTimeout(force);
            }
        })());
    }
    fail(error) {
        if (this.failure)
            return;
        this.failure = error;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
    send(message) {
        if (this.failure)
            return;
        try {
            this.child.stdin.write(encode(message));
        }
        catch (error) {
            this.fail(error);
            void this.close();
        }
    }
    read(chunk) {
        if (this.failure)
            return;
        this.buffer += chunk;
        let end;
        while ((end = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, end);
            this.buffer = this.buffer.slice(end + 1);
            if (Buffer.byteLength(line) > MAX_IN)
                break;
            if (!line.trim())
                continue;
            try {
                const frame = fields(JSON.parse(line));
                if (!frame || frame.jsonrpc !== "2.0")
                    throw new Error("invalid envelope");
                this.route(frame);
            }
            catch {
                this.fail(new Error("AGY ACP sent an invalid JSON-RPC frame"));
                void this.close();
                return;
            }
            if (this.failure)
                return;
        }
        if (end !== -1 || Buffer.byteLength(this.buffer) > MAX_IN) {
            this.fail(new Error("AGY ACP incoming frame exceeds size limit"));
            void this.close();
        }
    }
    route(frame) {
        const { method, id } = frame;
        if (typeof method === "string") {
            const params = fields(frame.params) ?? {};
            if (!("id" in frame)) {
                this.onAgentMessage?.(method, params, false);
                return;
            }
            if (typeof id !== "string" && typeof id !== "number")
                return;
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
        if (typeof id !== "number")
            return;
        const pending = this.pending.get(id);
        if (!pending)
            return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if ("result" in frame && !("error" in frame))
            pending.resolve(frame.result);
        else {
            const code = fields(frame.error)?.code;
            pending.reject(new Error(`AGY ACP request failed${typeof code === "number" ? ` (${code})` : ""}`));
        }
    }
}
//# sourceMappingURL=agy-connection.js.map