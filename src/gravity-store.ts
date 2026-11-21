import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Which AGY conversation continues a DSH session, so a restart can `session/load` it. */
export interface ResumeMap {
  get(id: string): { agyId: string; cwd: string } | undefined;
  set(id: string, agyId: string, cwd: string): void;
  delete(id: string): void;
}

/** JSON file store. shortcut: read-modify-write per call, no cross-process lock; fine for one DSH, upgrade if two share a state dir. */
export function fileResumeMap(file = join(process.env.DSH_GRAVITY_STATE_DIR || join(homedir(), ".local", "state", "dsh-oh-my-gravity"), "sessions.json")): ResumeMap {
  const read = (): Record<string, { agyId: string; cwd: string }> => {
    try {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as never) : {};
    } catch {
      return {};
    }
  };
  const write = (data: object) => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, file);
  };
  return {
    get(id) {
      const e = read()[id];
      return e && typeof e.agyId === "string" && typeof e.cwd === "string" ? e : undefined;
    },
    set(id, agyId, cwd) { write({ ...read(), [id]: { agyId, cwd } }); },
    delete(id) { const { [id]: _, ...rest } = read(); write(rest); },
  };
}
