/** Which AGY conversation continues a DSH session, so a restart can `session/load` it. */
export interface ResumeMap {
    get(id: string): {
        agyId: string;
        cwd: string;
    } | undefined;
    set(id: string, agyId: string, cwd: string): void;
    delete(id: string): void;
}
/** JSON file store. shortcut: read-modify-write per call, no cross-process lock; fine for one DSH, upgrade if two share a state dir. */
export declare function fileResumeMap(file?: string): ResumeMap;
