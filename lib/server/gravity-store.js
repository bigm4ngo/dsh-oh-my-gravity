import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
/** JSON file store. shortcut: read-modify-write per call, no cross-process lock; fine for one DSH, upgrade if two share a state dir. */
export function fileResumeMap(file = join(process.env.DSH_GRAVITY_STATE_DIR || join(homedir(), ".local", "state", "dsh-oh-my-gravity"), "sessions.json")) {
    const read = () => {
        try {
            const raw = JSON.parse(readFileSync(file, "utf8"));
            return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
        }
        catch {
            return {};
        }
    };
    const write = (data) => {
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
//# sourceMappingURL=gravity-store.js.map