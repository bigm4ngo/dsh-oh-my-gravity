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
export declare function parseSettings(raw: unknown): GravitySettings;
/** shortcut: read on every get, no cache and no cross-process lock; fine for one DSH, upgrade if two share a state dir. */
export declare function fileSettings(file?: string): SettingsStore;
