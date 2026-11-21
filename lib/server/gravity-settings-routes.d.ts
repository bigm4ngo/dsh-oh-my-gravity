import type { IncomingMessage, ServerResponse } from "node:http";
import type { SettingsStore } from "./gravity-settings.js";
import type { QuotaReply } from "./gravity-quota.js";
export declare const ROUTE = "/dsh-oh-my-gravity";
/** What the page shows about AGY and the plugin; assembled by the host. */
export interface SettingsStatus {
    command: string;
    /** `agy --version`, or undefined when AGY did not run. */
    version?: string;
    /** AGY answered a session request, which it only does when signed in. */
    signedIn: boolean;
    /** The subscription tier AGY reports (for example "Google AI Pro"). */
    plan?: string;
    /** One entry per picker model, as AGY reports them, before any hiding. */
    models: {
        id: string;
        name: string;
    }[];
    /** Models the profile's `models` config leaves out; the page cannot change those. */
    lockedModels: string[];
}
export interface SettingsDeps {
    settings: SettingsStore;
    /** `fresh`: ask AGY anew instead of answering from what is already known. */
    status: (fresh: boolean) => Promise<SettingsStatus>;
    /** Current Antigravity plan quota; optional for tests/hosts that omit quota probing. */
    quota?: (fresh: boolean) => Promise<QuotaReply>;
}
/** DSH's Host/Origin fence plus sign-in check: an HTTP status to refuse with, or undefined to let the request through. */
export type Reject = (req: IncomingMessage) => number | undefined;
/** The Settings page's API: GET /api/status, GET /api/quota, POST /api/settings. Every failure is a JSON body with a status. */
export declare function handleSettings(request: Request, { settings, status, quota }: SettingsDeps): Promise<Response>;
/** Shares one in-flight run among concurrent callers and reuses a successful result for `ms`; a failure is neither shared later nor kept. */
export declare function throttled<T>(run: () => Promise<T>, ms: number): () => Promise<T>;
/** The same API as a Node (req, res) route, which is what DSH needs for POST: its `resource` routes answer GET and HEAD only. */
export declare function nodeHandler(deps: SettingsDeps, reject: Reject): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
