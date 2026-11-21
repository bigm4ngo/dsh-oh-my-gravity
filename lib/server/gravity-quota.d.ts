export type QuotaFamily = "gemini" | "third-party" | "other";
export type QuotaWindow = "5h" | "weekly" | "other";
export interface QuotaBucket {
    id: string;
    label: string;
    family: QuotaFamily;
    window: QuotaWindow;
    remainingPercent: number;
    usedPercent: number;
    resetsAt: number | null;
    disabled?: boolean;
}
export type QuotaReply = {
    ok: true;
    fetchedAt: number;
    plan?: string;
    email?: string;
    buckets: QuotaBucket[];
} | {
    ok: false;
    error: string;
    fetchedAt?: number;
};
/** Parses AGY's documented `statusLine` JSON payload into normalized quota buckets. */
export declare function parseStatusLineQuota(payload: unknown, now?: number): {
    buckets: QuotaBucket[];
    email?: string;
    plan?: string;
} | undefined;
/** Starts AGY briefly inside a PTY with a temporary `statusLine` command to read current quota without creating a conversation. */
export declare function probeAgyQuota(opts: {
    command: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
}): Promise<unknown>;
export interface QuotaServiceOptions {
    command: string;
    env: NodeJS.ProcessEnv;
    cacheFile?: string;
    cacheMs?: number;
    forceMinAgeMs?: number;
    turnRefreshMinAgeMs?: number;
    timeoutMs?: number;
    getPlan?: () => Promise<string | undefined>;
    probe?: (signal: AbortSignal) => Promise<unknown>;
    now?: () => number;
    log?: (message: string) => void;
}
export interface QuotaService {
    get(opts: {
        fresh: boolean;
    }): Promise<QuotaReply>;
    noteTurnCompleted(): void;
    close(): void;
}
/** Coalesced, disk-backed cache around Antigravity's statusLine quota payload. */
export declare function createQuotaService(opts: QuotaServiceOptions): QuotaService;
