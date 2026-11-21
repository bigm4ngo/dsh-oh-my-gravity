import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const round1 = (value) => Math.round(value * 10) / 10;
const KNOWN_BUCKETS = {
    "gemini-5h": { label: "Gemini 5-hour", family: "gemini", window: "5h", order: 10 },
    "gemini-weekly": { label: "Gemini weekly", family: "gemini", window: "weekly", order: 20 },
    "gemini-argon-wtu-weekly": { label: "Gemini Argon weekly", family: "gemini", window: "weekly", order: 25 },
    "3p-5h": { label: "Claude / GPT 5-hour", family: "third-party", window: "5h", order: 30 },
    "3p-weekly": { label: "Claude / GPT weekly", family: "third-party", window: "weekly", order: 40 },
};
function inferBucketMeta(id) {
    const known = KNOWN_BUCKETS[id];
    if (known)
        return known;
    const family = id.startsWith("gemini") ? "gemini" : id.startsWith("3p") ? "third-party" : "other";
    const window = id.endsWith("-5h") ? "5h" : id.endsWith("-weekly") ? "weekly" : "other";
    let human = id
        .replace(/^3p-/, "Claude / GPT ")
        .replace(/-/g, " ")
        .replace(/\b5h$/, "5-hour")
        .replace(/\s+/g, " ")
        .trim();
    if (human)
        human = human[0].toUpperCase() + human.slice(1);
    return { label: human || id, family, window, order: 50 };
}
function parseResetAt(raw, now) {
    let ms = Number.NaN;
    if (typeof raw.reset_time === "string" && raw.reset_time.trim()) {
        ms = Date.parse(raw.reset_time);
    }
    if (!Number.isFinite(ms) && typeof raw.reset_in_seconds === "number" && Number.isFinite(raw.reset_in_seconds)) {
        ms = now + raw.reset_in_seconds * 1000;
    }
    return Number.isFinite(ms) ? Math.round(ms / 60_000) * 60_000 : null;
}
/** Parses AGY's documented `statusLine` JSON payload into normalized quota buckets. */
export function parseStatusLineQuota(payload, now = Date.now()) {
    const root = object(payload);
    const rawQuota = object(root?.quota);
    if (!rawQuota)
        return undefined;
    const keyed = [];
    for (const [id, value] of Object.entries(rawQuota)) {
        const entry = object(value);
        const frac = entry?.remaining_fraction;
        if (!entry || typeof frac !== "number" || !Number.isFinite(frac))
            continue;
        const meta = inferBucketMeta(id);
        const remainingPercent = round1(clamp01(frac) * 100);
        const usedPercent = round1(100 - remainingPercent);
        const resetsAt = parseResetAt(entry, now);
        keyed.push({
            order: meta.order,
            bucket: {
                id,
                label: meta.label,
                family: meta.family,
                window: meta.window,
                remainingPercent,
                usedPercent,
                resetsAt,
                ...(entry.disabled === true ? { disabled: true } : {}),
            },
        });
    }
    if (keyed.length === 0)
        return undefined;
    keyed.sort((a, b) => a.order - b.order || a.bucket.id.localeCompare(b.bucket.id));
    const email = typeof root?.email === "string" && root.email.trim() ? root.email.trim() : undefined;
    const plan = typeof root?.plan_tier === "string" && root.plan_tier.trim() ? root.plan_tier.trim() : undefined;
    return {
        buckets: keyed.map((k) => k.bucket),
        ...(email ? { email } : {}),
        ...(plan ? { plan } : {}),
    };
}
const PTY_PROBE_SCRIPT = String.raw `
import fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios, time

command, settings_file, out_file, timeout_s = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
master, slave = pty.openpty()
try:
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 120, 0, 0))
except Exception:
    pass

proc = subprocess.Popen(
    [command, "--settings", settings_file],
    stdin=slave,
    stdout=slave,
    stderr=slave,
    start_new_session=True,
)
os.close(slave)

def terminate():
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except Exception:
        pass
    try:
        proc.wait(timeout=2)
    except Exception:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except Exception:
            pass

def read_quota_payload():
    if not os.path.exists(out_file):
        return None
    try:
        with open(out_file, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if isinstance(obj, dict) and isinstance(obj.get("quota"), dict) and len(obj["quota"]) > 0:
                    return line
    except Exception:
        pass
    return None

def on_signal(signum, frame):
    terminate()
    sys.exit(128 + signum)

signal.signal(signal.SIGTERM, on_signal)
signal.signal(signal.SIGINT, on_signal)

deadline = time.monotonic() + timeout_s
found = None
try:
    while time.monotonic() < deadline:
        r, _, _ = select.select([master], [], [], 0.15)
        if r:
            try:
                os.read(master, 4096)
            except OSError:
                break
        found = read_quota_payload()
        if found is not None:
            break
        if proc.poll() is not None:
            found = read_quota_payload()
            break
finally:
    terminate()
    try:
        os.close(master)
    except OSError:
        pass

if found is None:
    sys.stderr.write("Antigravity statusLine did not emit quota before exiting or timing out\n")
    sys.exit(1)

sys.stdout.write(found + "\n")
sys.stdout.flush()
`;
const quoteSh = (value) => `'${value.replaceAll("'", "'\\''")}'`;
/** Starts AGY briefly inside a PTY with a temporary `statusLine` command to read current quota without creating a conversation. */
export async function probeAgyQuota(opts) {
    if (opts.signal?.aborted)
        throw new Error("Antigravity quota check cancelled");
    const timeoutMs = Math.max(1000, opts.timeoutMs ?? 15_000);
    const dir = await mkdtemp(join(tmpdir(), "gravity-quota-"));
    const outFile = join(dir, "statusline.jsonl");
    const captureScript = join(dir, "capture.sh");
    const settingsFile = join(dir, "settings.json");
    try {
        await writeFile(captureScript, `#!/bin/sh\ncat >> ${quoteSh(outFile)}\nprintf '\\n' >> ${quoteSh(outFile)}\n`, { mode: 0o700 });
        await chmod(captureScript, 0o700);
        await writeFile(settingsFile, JSON.stringify({
            statusLine: { type: "command", command: captureScript, enabled: true },
        }), { mode: 0o600 });
        const env = { ...opts.env, TERM: opts.env.TERM || "xterm-256color" };
        const stdout = await new Promise((resolve, reject) => {
            const child = spawn("python3", [
                "-c",
                PTY_PROBE_SCRIPT,
                opts.command,
                settingsFile,
                outFile,
                String(timeoutMs / 1000),
            ], {
                env,
                cwd: dir,
                stdio: ["ignore", "pipe", "pipe"],
            });
            let out = "";
            let err = "";
            let settled = false;
            const done = (fn) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(hardTimer);
                opts.signal?.removeEventListener("abort", onAbort);
                fn();
            };
            const onAbort = () => {
                child.kill("SIGTERM");
                done(() => reject(new Error("Antigravity quota check cancelled")));
            };
            const hardTimer = setTimeout(() => {
                child.kill("SIGTERM");
                setTimeout(() => { try {
                    child.kill("SIGKILL");
                }
                catch { /* ignore */ } }, 1000).unref();
                done(() => reject(new Error(`Antigravity quota check timed out after ${Math.round(timeoutMs / 1000)}s`)));
            }, timeoutMs + 3000);
            hardTimer.unref();
            opts.signal?.addEventListener("abort", onAbort, { once: true });
            child.stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
            child.stderr.on("data", (chunk) => { err += chunk.toString("utf8"); });
            child.on("error", (error) => {
                done(() => reject(error.code === "ENOENT"
                    ? new Error("python3 is required to probe Antigravity quota via PTY")
                    : error));
            });
            child.on("close", (code) => {
                done(() => {
                    if (code === 0 && out.trim())
                        resolve(out.trim());
                    else
                        reject(new Error(err.trim() || `Antigravity quota check failed (exit ${code ?? "?"})`));
                });
            });
        });
        const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
        return JSON.parse(lines.at(-1));
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}
function isGoodQuota(value) {
    const rec = object(value);
    return !!rec &&
        rec.ok === true &&
        typeof rec.fetchedAt === "number" &&
        Number.isFinite(rec.fetchedAt) &&
        Array.isArray(rec.buckets) &&
        rec.buckets.every((b) => {
            const entry = object(b);
            return !!entry && typeof entry.id === "string" && typeof entry.label === "string" && typeof entry.remainingPercent === "number";
        });
}
/** Coalesced, disk-backed cache around Antigravity's statusLine quota payload. */
export function createQuotaService(opts) {
    const cacheMs = opts.cacheMs ?? 5 * 60_000;
    const forceMinAgeMs = opts.forceMinAgeMs ?? 30_000;
    const turnRefreshMinAgeMs = opts.turnRefreshMinAgeMs ?? 2 * 60_000;
    const now = opts.now ?? Date.now;
    let cached;
    let diskRead = false;
    let disposed = false;
    let inFlight;
    let activeAbort;
    const readDisk = () => {
        if (diskRead || cached || !opts.cacheFile)
            return;
        diskRead = true;
        try {
            const parsed = JSON.parse(readFileSync(opts.cacheFile, "utf8"));
            if (isGoodQuota(parsed))
                cached = parsed;
        }
        catch { /* missing or corrupt cache is rebuilt on next check */ }
    };
    const writeDisk = (entry) => {
        if (!opts.cacheFile)
            return;
        try {
            mkdirSync(dirname(opts.cacheFile), { recursive: true });
            const tmp = `${opts.cacheFile}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
            renameSync(tmp, opts.cacheFile);
        }
        catch { /* quota still works from memory */ }
    };
    const runProbe = () => {
        if (inFlight)
            return inFlight;
        if (disposed)
            return Promise.resolve({ ok: false, error: "Antigravity quota service stopped" });
        const controller = new AbortController();
        activeAbort = controller;
        inFlight = (async () => {
            try {
                const raw = await (opts.probe
                    ? opts.probe(controller.signal)
                    : probeAgyQuota({ command: opts.command, env: opts.env, timeoutMs: opts.timeoutMs, signal: controller.signal }));
                const parsed = parseStatusLineQuota(raw, now());
                if (!parsed)
                    throw new Error("Antigravity returned no quota buckets");
                const plan = parsed.plan ?? (await opts.getPlan?.().catch(() => undefined));
                const next = {
                    ok: true,
                    fetchedAt: now(),
                    ...(plan ? { plan } : {}),
                    ...(parsed.email ? { email: parsed.email } : {}),
                    buckets: parsed.buckets,
                };
                cached = next;
                writeDisk(next);
                return next;
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                opts.log?.(`quota check failed: ${message}`);
                return { ok: false, error: message };
            }
            finally {
                if (activeAbort === controller)
                    activeAbort = undefined;
                inFlight = undefined;
            }
        })();
        return inFlight;
    };
    return {
        async get({ fresh }) {
            readDisk();
            const age = cached ? Math.max(0, now() - cached.fetchedAt) : Infinity;
            if (fresh) {
                if (cached && age < forceMinAgeMs)
                    return cached;
                return runProbe();
            }
            if (cached) {
                if (age >= cacheMs && !disposed)
                    void runProbe();
                return cached;
            }
            return runProbe();
        },
        noteTurnCompleted() {
            readDisk();
            if (disposed || inFlight)
                return;
            const age = cached ? Math.max(0, now() - cached.fetchedAt) : Infinity;
            if (age >= turnRefreshMinAgeMs)
                void runProbe();
        },
        close() {
            disposed = true;
            activeAbort?.abort();
        },
    };
}
//# sourceMappingURL=gravity-quota.js.map