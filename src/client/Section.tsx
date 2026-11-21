import { useCallback, useEffect, useState } from "react";
import { formatPercent, formatReset, loadQuota, remainingTone, type QuotaReply } from "./quota.js";

const ROUTE = "/dsh-oh-my-gravity";

interface Status {
  command: string;
  version?: string;
  signedIn: boolean;
  plan?: string;
  models: { id: string; name: string }[];
  lockedModels: string[];
  settings: { hiddenModels: string[]; dshTools: boolean };
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${ROUTE}${path}`, {
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !data) throw new Error(data?.error ?? `request failed (${response.status})`);
  return data;
}

function Switch(props: { checked: boolean; disabled?: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <input
      type="checkbox"
      role="switch"
      className="omg-switch"
      aria-label={props.label}
      checked={props.checked}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.currentTarget.checked)}
    />
  );
}

const TONE_CLASS = { err: "omg-bad", warn: "omg-warn", ok: "omg-good" } as const;
const TONE_FILL = {
  err: "var(--dsw-alias-state-error-primary, #dc2626)",
  warn: "var(--dsw-alias-state-warn-primary, #d9822b)",
  ok: "var(--dsw-alias-state-success-primary, #16a34a)",
} as const;

export function Section() {
  const [status, setStatus] = useState<Status>();
  const [quota, setQuota] = useState<QuotaReply>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [quotaBusy, setQuotaBusy] = useState(false);

  const refreshQuota = useCallback(async (fresh = false) => {
    setQuotaBusy(true);
    try {
      setQuota(await loadQuota(fresh));
    } finally {
      setQuotaBusy(false);
    }
  }, []);

  const load = useCallback(async (fresh = false) => {
    setBusy(true);
    try {
      setStatus(await call<Status>(fresh ? "/api/status?fresh=1" : "/api/status"));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void refreshQuota(false);
  }, [load, refreshQuota]);

  const save = async (change: Partial<Status["settings"]>) => {
    try {
      const settings = await call<Status["settings"]>("/api/settings", change);
      setStatus((current) => current && { ...current, settings });
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!status) {
    return <div className="omg">{error ? <div className="omg-bad">{error}</div> : <div className="omg-dim">Checking Antigravity…</div>}</div>;
  }
  const hidden = new Set(status.settings.hiddenModels);
  return (
    <div className="omg">
      {error ? <div className="omg-bad" role="alert">{error}</div> : null}

      <div className="omg-card">
        <h3>Antigravity CLI</h3>
        <div className="omg-row"><span>Command</span><code>{status.command}</code></div>
        <div className="omg-row">
          <span>Version</span>
          {status.version ? <code>{status.version}</code> : <span className="omg-bad">not found: install agy or set <code>command</code> in cordis.patch.yml</span>}
        </div>
        {status.plan ? <div className="omg-row"><span>Plan</span><span>{status.plan}</span></div> : null}
        <div className="omg-row">
          <span>Sign-in</span>
          {status.signedIn ? <span className="omg-good">signed in</span> : <span className="omg-bad">AGY did not answer; run <code>agy</code> once to sign in</span>}
        </div>
        <div className="omg-row"><span className="omg-dim">Shown from the last check; "Check again" asks AGY now.</span><button className="omg-btn" disabled={busy} onClick={() => { void load(true); }}>{busy ? "Checking…" : "Check again"}</button></div>
      </div>

      <div className="omg-card">
        <h3>Plan quota</h3>
        {!quota ? (
          <div className="omg-dim">Checking quota…</div>
        ) : !quota.ok ? (
          <div className="omg-bad">{quota.error}</div>
        ) : (
          quota.buckets.map((bucket) => {
            const tone = remainingTone(bucket.remainingPercent);
            const pct = Math.max(0, Math.min(100, bucket.remainingPercent));
            const reset = formatReset(bucket.resetsAt);
            return (
              <div className="omg-quota-item" key={bucket.id}>
                <div className="omg-quota-head">
                  <span>{bucket.label}{bucket.disabled ? <span className="omg-dim"> (paused)</span> : null}</span>
                  <span className={`omg-quota-val ${TONE_CLASS[tone]}`}>{formatPercent(pct)} left</span>
                </div>
                <div className="omg-quota-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={`${bucket.label} ${formatPercent(pct)} remaining`}>
                  <div className="omg-quota-fill" style={{ width: `${pct}%`, background: TONE_FILL[tone] }} />
                </div>
                {reset ? <div className="omg-quota-meta">{reset}</div> : null}
              </div>
            );
          })
        )}
        <div className="omg-row">
          <span className="omg-dim">{quota?.ok ? `Updated ${new Date(quota.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Reads AGY's statusLine quota payload."}</span>
          <button className="omg-btn" disabled={quotaBusy} onClick={() => { void refreshQuota(true); }}>{quotaBusy ? "Refreshing…" : "Refresh quota"}</button>
        </div>
      </div>

      <div className="omg-card">
        <h3>Models in the picker</h3>
        {status.models.length === 0 ? <div className="omg-dim">AGY reported no models.</div> : null}
        {status.models.map((model) => {
          const locked = status.lockedModels.includes(model.id);
          return (
            <div className="omg-row" key={model.id}>
              <span>{model.name} <code className="omg-dim">{model.id}</code>{locked ? <span className="omg-dim"> · left out by the profile's models setting</span> : null}</span>
              <Switch
                label={`Show ${model.name}`}
                checked={!locked && !hidden.has(model.id)}
                disabled={locked}
                onChange={(show) => { void save({ hiddenModels: show ? [...hidden].filter((id) => id !== model.id) : [...hidden, model.id] }); }}
              />
            </div>
          );
        })}
        <div className="omg-dim">Takes effect when the picker next loads. A session already on a hidden model keeps working. Reasoning effort comes from DSH's effort chooser, for models that have levels (Gemini 3.8 Flash).</div>
      </div>

      <div className="omg-card">
        <h3>DSH tools</h3>
        <div className="omg-row">
          <span>Let Antigravity use DSH's tools (subagents, jobs, skills…)</span>
          <Switch label="DSH tools for Antigravity" checked={status.settings.dshTools} onChange={(on) => { void save({ dshTools: on }); }} />
        </div>
        <div className="omg-dim">Every call asks for approval through DSH's own approval setting, with its arguments shown. Applies to sessions Antigravity starts from now on.</div>
      </div>
    </div>
  );
}
