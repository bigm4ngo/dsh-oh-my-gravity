import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
export const KEY_HEADER = "x-gravity-key";
const BODY_LIMIT = 1024 * 1024;
/** DSH tools AGY already has natively, plus DSH's code-mode transport, which is not a tool. */
const HIDDEN = new Set(["read", "write", "edit", "multi_edit", "str_replace_editor", "glob", "grep", "ls", "run_code"]);
const record = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** Serves the DSH tools an agent can see to AGY over MCP Streamable HTTP on loopback. Tools run
 *  here, inside DSH; AGY asks DSH's approval for each call before it reaches this server. */
export async function startToolBridge(tools, agentFor, approve, 
/** A reason this tool may not run in this session right now (DSH has it read-only), or undefined. */
refuse = () => undefined) {
    const grants = new Map(); // key → DSH session id
    const send = (res, status, body) => {
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const readBody = (req) => new Promise((resolve) => {
        const parts = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > BODY_LIMIT)
                resolve(undefined); // answered 413, then the connection is dropped
            else
                parts.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
        req.on("error", () => resolve(undefined));
    });
    async function handle(req, res) {
        const presented = req.headers[KEY_HEADER];
        const key = typeof presented === "string" ? presented : "";
        const granted = [...grants].find(([k]) => same(k, key));
        if (!granted)
            return send(res, 401);
        if (req.method !== "POST")
            return send(res, 405);
        const raw = await readBody(req);
        if (raw === undefined) {
            res.once("finish", () => req.destroy());
            return send(res, 413);
        }
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            return send(res, 400);
        }
        if (!msg || typeof msg !== "object" || msg.id === undefined)
            return send(res, 202); // notifications need no reply
        const reply = (result) => send(res, 200, { jsonrpc: "2.0", id: msg.id, result });
        const fail = (code, message) => send(res, 200, { jsonrpc: "2.0", id: msg.id, error: { code, message } });
        const agent = agentFor(granted[1]);
        const params = record(msg.params);
        switch (msg.method) {
            case "initialize":
                return reply({
                    protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: "dsh", version: "0.1.0" },
                });
            case "ping":
                return reply({});
            case "tools/list":
                if (!agent)
                    return fail(-32000, "the DSH session for this connection is gone");
                return reply({
                    tools: tools.schemas(agent).filter((t) => !HIDDEN.has(t.name))
                        .map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
                });
            case "tools/call": {
                if (!agent)
                    return fail(-32000, "the DSH session for this connection is gone");
                const name = typeof params?.name === "string" ? params.name : "";
                const args = record(params?.arguments) ?? {};
                const tool = HIDDEN.has(name) ? undefined : tools.get(name, agent);
                const failed = (text) => reply({ isError: true, content: [{ type: "text", text }] });
                if (!tool)
                    return failed(`unknown tool ${name}`);
                const barred = refuse(granted[1], name);
                if (barred)
                    return failed(barred);
                // DSH's approval is enforced here, not left to AGY: AGY's own settings may allow MCP calls unasked.
                const abort = new AbortController();
                res.once("close", () => { if (!res.writableEnded)
                    abort.abort(); });
                let outcome = "unavailable";
                try {
                    outcome = await approve(granted[1], name, args, abort.signal);
                }
                catch { /* cannot ask: fail closed */ }
                if (outcome !== "allowed-once")
                    return failed(`${name} was not approved (${outcome})`);
                try {
                    const exec = { agent, signal: abort.signal, name, arguments: args, callId: randomUUID() };
                    const returned = await tool.execute(args, exec);
                    const shown = tool.output?.render ? tool.output.render(args, returned) : returned;
                    return reply({ content: [{ type: "text", text: typeof shown === "string" ? shown : JSON.stringify(shown) ?? "" }] });
                }
                catch (error) {
                    return failed(error instanceof Error ? error.message : String(error));
                }
            }
            default:
                return fail(-32601, `unknown method ${String(msg.method)}`);
        }
    }
    const server = createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent)
        send(res, 500); }); });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    return {
        url,
        issue(sessionId) {
            const key = randomBytes(32).toString("hex");
            grants.set(key, sessionId);
            return { config: { type: "http", name: "dsh", url, headers: [{ name: KEY_HEADER, value: key }] }, revoke: () => { grants.delete(key); } };
        },
        close: () => new Promise((resolve) => { grants.clear(); server.close(() => resolve()); server.closeAllConnections(); }),
    };
}
//# sourceMappingURL=gravity-mcp.js.map