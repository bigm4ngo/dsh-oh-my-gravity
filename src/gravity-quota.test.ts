import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQuotaService, parseStatusLineQuota, probeAgyQuota } from "./gravity-quota.js";

const now = Date.parse("2026-11-21T14:12:03Z");

// Real AGY 1.5.14 statusLine payload with all 5 quota buckets.
const samplePayload = {
  version: "1.5.14",
  plan_tier: "Google AI Pro",
  email: "user@example.com",
  quota: {
    "3p-5h": { remaining_fraction: 0.9539784, reset_time: "2026-11-21T15:31:31Z", reset_in_seconds: 4770 },
    "3p-weekly": { remaining_fraction: 0.9769892, reset_time: "2026-11-28T10:31:31Z", reset_in_seconds: 591570 },
    "gemini-5h": { remaining_fraction: 0.12853193, reset_time: "2026-11-21T15:25:24Z", reset_in_seconds: 4403 },
    "gemini-argon-wtu-weekly": { remaining_fraction: 0.9739593, reset_time: "2026-11-28T10:31:13Z", reset_in_seconds: 591552 },
    "gemini-weekly": { remaining_fraction: 0.75100917, reset_time: "2026-11-28T10:25:24Z", reset_in_seconds: 591203 },
  },
};

const parsed = parseStatusLineQuota(samplePayload, now);
assert.ok(parsed);
assert.equal(parsed.email, "user@example.com");
assert.equal(parsed.plan, "Google AI Pro");
assert.deepEqual(
  parsed.buckets.map((b) => b.id),
  ["gemini-5h", "gemini-weekly", "gemini-argon-wtu-weekly", "3p-5h", "3p-weekly"],
);
assert.equal(parsed.buckets[0]!.label, "Gemini 5-hour");
assert.equal(parsed.buckets[0]!.family, "gemini");
assert.equal(parsed.buckets[0]!.window, "5h");
assert.equal(parsed.buckets[0]!.remainingPercent, 12.9);
assert.equal(parsed.buckets[0]!.usedPercent, 87.1);
assert.equal(parsed.buckets[0]!.resetsAt, Math.round(Date.parse("2026-11-21T15:25:24Z") / 60_000) * 60_000);

// Fallback reset_in_seconds, clamping, disabled flag, and unknown bucket humanization.
const extra = parseStatusLineQuota({
  quota: {
    "custom-alpha-5h": { remaining_fraction: 1.5, reset_in_seconds: 300, disabled: true },
    "broken": { remaining_fraction: "nope" },
  },
}, now);
assert.ok(extra);
assert.equal(extra.buckets.length, 1);
assert.equal(extra.buckets[0]!.id, "custom-alpha-5h");
assert.equal(extra.buckets[0]!.label, "Custom alpha 5-hour");
assert.equal(extra.buckets[0]!.family, "other");
assert.equal(extra.buckets[0]!.window, "5h");
assert.equal(extra.buckets[0]!.remainingPercent, 100);
assert.equal(extra.buckets[0]!.usedPercent, 0);
assert.equal(extra.buckets[0]!.disabled, true);
assert.equal(extra.buckets[0]!.resetsAt, Math.round((now + 300_000) / 60_000) * 60_000);

// Empty / null quota returns undefined.
assert.equal(parseStatusLineQuota({ quota: null }), undefined);
assert.equal(parseStatusLineQuota({ quota: {} }), undefined);
assert.equal(parseStatusLineQuota(undefined), undefined);

// QuotaService: coalescing, disk persistence, stale-while-revalidate, forceMinAgeMs, failure keeps disk cache, and turn refresh throttle.
const dir = mkdtempSync(join(tmpdir(), "gravity-quota-test-"));
try {
  const cacheFile = join(dir, "quota.json");
  let clock = now;
  let calls = 0;
  let failProbe = false;
  const payloadWithoutPlan = {
    quota: { "gemini-5h": { remaining_fraction: 0.42, reset_in_seconds: 3600 } },
  };
  const service = createQuotaService({
    command: "agy",
    env: process.env,
    cacheFile,
    cacheMs: 5 * 60_000,
    forceMinAgeMs: 30_000,
    turnRefreshMinAgeMs: 2 * 60_000,
    now: () => clock,
    getPlan: async () => "Google AI Pro",
    probe: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      if (failProbe) throw new Error("probe boom");
      return payloadWithoutPlan;
    },
  });

  // Concurrent cold calls share one probe.
  const [r1, r2, r3] = await Promise.all([
    service.get({ fresh: false }),
    service.get({ fresh: false }),
    service.get({ fresh: false }),
  ]);
  assert.equal(calls, 1);
  assert.equal(r1.ok, true);
  assert.deepEqual(r1, r2);
  assert.deepEqual(r2, r3);
  assert.equal((r1 as Extract<typeof r1, { ok: true }>).plan, "Google AI Pro");
  assert.equal(existsSync(cacheFile), true);

  // fresh: true inside forceMinAgeMs reuses cache without probing again.
  await service.get({ fresh: true });
  assert.equal(calls, 1);

  // Advance 35s: fresh: true triggers probe; failure returns ok:false but preserves good disk snapshot.
  clock += 35_000;
  failProbe = true;
  const failed = await service.get({ fresh: true });
  assert.equal(calls, 2);
  assert.equal(failed.ok, false);
  assert.match((failed as Extract<typeof failed, { ok: false }>).error, /probe boom/);
  const diskCopy = JSON.parse(readFileSync(cacheFile, "utf8")) as { ok: boolean; buckets: unknown[] };
  assert.equal(diskCopy.ok, true);
  assert.equal(diskCopy.buckets.length, 1);

  // Reloading in a new service instance serves the persisted disk snapshot immediately while stale-refreshing in background.
  failProbe = false;
  let calls2 = 0;
  let clock2 = now + 6 * 60_000;
  const reloaded = createQuotaService({
    command: "agy",
    env: process.env,
    cacheFile,
    cacheMs: 5 * 60_000,
    now: () => clock2,
    probe: async () => {
      calls2++;
      return { quota: { "gemini-5h": { remaining_fraction: 0.9, reset_in_seconds: 3600 } } };
    },
  });
  const warm = await reloaded.get({ fresh: false });
  assert.equal(warm.ok, true);
  assert.equal((warm as Extract<typeof warm, { ok: true }>).buckets[0]!.remainingPercent, 42);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls2, 1);
  const refreshed = await reloaded.get({ fresh: false });
  assert.equal((refreshed as Extract<typeof refreshed, { ok: true }>).buckets[0]!.remainingPercent, 90);

  // noteTurnCompleted throttles refreshes inside turnRefreshMinAgeMs.
  reloaded.noteTurnCompleted();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls2, 1);
  clock2 += 3 * 60_000;
  reloaded.noteTurnCompleted();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls2, 2);

  service.close();
  reloaded.close();

  // End-to-end PTY test of probeAgyQuota against a synthetic agy executable script.
  const fakeAgy = join(dir, "fake-agy");
  writeFileSync(
    fakeAgy,
    `#!${process.execPath}
const fs = require("node:fs");
const { execSync } = require("node:child_process");
const idx = process.argv.indexOf("--settings");
const settings = JSON.parse(fs.readFileSync(process.argv[idx + 1], "utf8"));
const payload = JSON.stringify({
  plan_tier: "Pro Synthetic",
  quota: { "gemini-5h": { remaining_fraction: 0.61, reset_in_seconds: 1800 } },
});
execSync(settings.statusLine.command, { input: payload, stdio: ["pipe", "ignore", "ignore"] });
setInterval(() => {}, 1000);
process.on("SIGTERM", () => process.exit(0));
`,
    "utf8",
  );
  await chmod(fakeAgy, 0o755);

  const ptyRaw = (await probeAgyQuota({ command: fakeAgy, env: process.env, timeoutMs: 8000 })) as Record<string, unknown>;
  const ptyParsed = parseStatusLineQuota(ptyRaw, now);
  assert.ok(ptyParsed);
  assert.equal(ptyParsed.plan, "Pro Synthetic");
  assert.equal(ptyParsed.buckets[0]!.remainingPercent, 61);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("gravity quota: ok");
