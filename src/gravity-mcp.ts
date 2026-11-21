import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Agent, DshToolsRegistry, JsonValue } from "./dsh.js";

export const KEY_HEADER = "x-gravity-key";
const BODY_LIMIT = 1024 * 1024;
/** DSH tools AGY already has natively, plus DSH's code-mode transport, which is not a tool. */
const HIDDEN = new Set(["read", "write", "edit", "multi_edit", "str_replace_editor", "glob", "grep", "ls", "run_code"]);

export interface McpServerConfig {
  type: "http";
  name: "dsh";
  url: string;
  headers: { name: string; value: string }[];
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

type Rpc = { id?: number | string | null; method?: unknown; params?: unknown };
const record = (v: unknown): Record<string, JsonValue> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, JsonValue>) : undefined;

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Serves the DSH tools an agent can see to AGY over MCP Streamable HTTP on loopback.
 *  Tools enforce their own permissions inside DSH; the adapter enforces the read-only plan gate. */
export async function startToolBridge(
  tools: Pick<DshToolsRegistry, "schemas" | "get">,
  agentFor: (sessionId: string) => Agent | undefined,
  /** A reason this tool may not run in this session right now (DSH has it read-only), or undefined. */
  refuse: (sessionId: string, tool: string) => string | undefined = () => undefined,
): Promise<ToolBridge> {
  const grants = new Map<string, string>(); // key → DSH session id
  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) => new Promise<string | undefined>((resolve) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) resolve(undefined); // answered 413, then the connection is dropped
      else parts.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", () => resolve(undefined));
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const presented = req.headers[KEY_HEADER];
    const key = typeof presented === "string" ? presented : "";
    const granted = [...grants].find(([k]) => same(k, key));
    if (!granted) return send(res, 401);
    const sessionId = granted[1];
    if (req.method !== "POST") return send(res, 405);
    const raw = await readBody(req);
    if (raw === undefined) {
      res.once("finish", () => req.destroy());
      return send(res, 413);
    }
    let msg: Rpc;
    try { msg = JSON.parse(raw) as Rpc; } catch { return send(res, 400); }
    if (!msg || typeof msg !== "object" || msg.id === undefined) return send(res, 202); // notifications need no reply
    const reply = (result: object) => send(res, 200, { jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) => send(res, 200, { jsonrpc: "2.0", id: msg.id, error: { code, message } });
    const agent = agentFor(sessionId);
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
        if (!agent) return fail(-32000, "the DSH session for this connection is gone");
        return reply({
          tools: tools.schemas(agent).filter((t) => !HIDDEN.has(t.name))
            .map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
        });
      case "tools/call": {
        if (!agent) return fail(-32000, "the DSH session for this connection is gone");
        const name = typeof params?.name === "string" ? params.name : "";
        const args = record(params?.arguments) ?? {};
        const tool = HIDDEN.has(name) ? undefined : tools.get(name, agent);
        const failed = (text: string) => reply({ isError: true, content: [{ type: "text", text }] });
        if (!tool) return failed(`unknown tool ${name}`);
        const barred = refuse(sessionId, name);
        if (barred) return failed(barred);
        const abort = new AbortController();
        res.once("close", () => { if (!res.writableEnded) abort.abort(); });
        try {
          const exec = { agent, signal: abort.signal, name, arguments: args, callId: randomUUID() };
          const returned = await tool.execute(args, exec);
          const shown = tool.output?.render ? tool.output.render(args, returned) : returned;
          return reply({ content: [{ type: "text", text: typeof shown === "string" ? shown : JSON.stringify(shown) ?? "" }] });
        } catch (error) {
          return failed(error instanceof Error ? error.message : String(error));
        }
      }
      default:
        return fail(-32601, `unknown method ${String(msg.method)}`);
    }
  }

  const server = createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent) send(res, 500); }); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return {
    url,
    issue(sessionId) {
      const key = randomBytes(32).toString("hex");
      grants.set(key, sessionId);
      return {
        config: { type: "http", name: "dsh", url, headers: [{ name: KEY_HEADER, value: key }] },
        revoke: () => { grants.delete(key); },
        ownsTool: (tool: string) => {
          if (!grants.has(key) || HIDDEN.has(tool)) return false;
          const agent = agentFor(sessionId);
          return !!agent && !!tools.get(tool, agent);
        },
      };
    },
    close: () => new Promise<void>((resolve) => {
      grants.clear();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
