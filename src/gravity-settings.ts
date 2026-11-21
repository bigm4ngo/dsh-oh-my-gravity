import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** What the Settings page changes at runtime; kept beside the resume map, not in the profile. */
export interface GravitySettings {
  /** Model ids left out of the picker. */
  hiddenModels: string[];
  /** Whether new AGY sessions are given DSH's tools. */
  dshTools: boolean;
}
export interface SettingsStore {
  get(): GravitySettings;
  set(next: GravitySettings): void;
}

/** Decodes untrusted JSON into settings: anything unrecognised falls back to the default. */
export function parseSettings(raw: unknown): GravitySettings {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    hiddenModels: Array.isArray(o.hiddenModels) ? o.hiddenModels.filter((id): id is string => typeof id === "string" && id !== "") : [],
    dshTools: typeof o.dshTools === "boolean" ? o.dshTools : true,
  };
}

/** shortcut: read on every get, no cache and no cross-process lock; fine for one DSH, upgrade if two share a state dir. */
export function fileSettings(file = join(process.env.DSH_GRAVITY_STATE_DIR || join(homedir(), ".local", "state", "dsh-oh-my-gravity"), "settings.json")): SettingsStore {
  return {
    get() {
      try {
        return parseSettings(JSON.parse(readFileSync(file, "utf8")));
      } catch {
        return parseSettings(undefined);
      }
    },
    set(next) {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(parseSettings(next)), { mode: 0o600 });
      renameSync(tmp, file);
    },
  };
}
