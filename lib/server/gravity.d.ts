import type { IncomingMessage, ServerResponse } from "node:http";
import z from "@deepseek-ai/schemastery";
import type { DshToolsRegistry, PluginContext } from "./dsh.js";
export declare const name = "dsh-oh-my-gravity";
export declare const inject: string[];
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    command: z<string, string, "defined">;
    idleMinutes: z<number, number, "defined">;
    maxProcesses: z<number, number, "defined">;
    models: z<string[], string[], "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    command: z<string, string, "defined">;
    idleMinutes: z<number, number, "defined">;
    maxProcesses: z<number, number, "defined">;
    models: z<string[], string[], "defined">;
}>>, "plain">;
type GravityContext = {
    llm: {
        [K in "registerAdapter" | "registerConfigurableProviders"]: (...args: Parameters<PluginContext["llm"][K]>) => void;
    };
    sessions: Pick<PluginContext["sessions"], "get">;
    /** Present on a real DSH; the Settings routes need its web server. */
    inject?: (services: string[], callback: (host: {
        webServer: {
            register(route: {
                kind: "prefix";
                path: string;
                handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
            }): unknown;
        };
    }) => void) => void;
    effect?: (execute: () => unknown, label?: string) => void;
    get?: {
        (name: "agents"): Pick<PluginContext["agents"], "get"> | undefined;
        (name: "approval"): Pick<PluginContext["approval"], "request"> | undefined;
        (name: "connection"): {
            requestRejection(req: IncomingMessage): number | undefined;
        } | undefined;
        (name: "tools"): Pick<DshToolsRegistry, "schemas" | "get"> | undefined;
    };
};
export declare const apply: (ctx: GravityContext, config: Schemastery.TypeT<typeof Config>) => () => Promise<void>;
export {};
