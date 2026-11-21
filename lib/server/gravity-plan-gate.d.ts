import type { GenerateOptions } from "@deepseek-ai/dsh-llm";
/** DSH's access mode is AGY's session mode: read-only plans, workspace-write runs auto inside `agy acp --sandbox`, and danger-full-access uses `--dangerously-skip-permissions` when configured. */
export declare const MODE_FOR_ACCESS: Readonly<Record<string, string>>;
export declare const READ_ONLY_AGY_TOOLS: ReadonlySet<string>;
/**
 * In `read-only` and `workspace-write`, ordinary reads outside the workspace match native DSH
 * and are auto-allowed unless any target path touches sensitive credential/key locations.
 */
export declare function isAutoAllowedRead(access: string | undefined, toolName: string, kind: string | undefined, paths: readonly string[]): boolean;
/**
 * DSH's access mode, from the runtime-context message DSH injects each turn: the `sandbox:policy` section of its structured
 * `source`, which only DSH sets. Message text is never read, so a pasted page or a user-authored line cannot claim a
 * mode. The last snapshot wins; with none, or one that does not parse exactly, there is no mode and AGY stays on its default.
 */
export declare function accessModeOf(messages: GenerateOptions["messages"] | undefined): string | undefined;
/**
 * DSH tools that only read, so a read-only session may run them. An allowlist on purpose: a tool DSH adds later
 * is refused until someone reads what it does. the list below was checked against DSH's tool packages on 2026-11-10.
 */
export declare const READ_ONLY_TOOLS: ReadonlySet<string>;
/** Why a DSH tool may not run in a session DSH holds read-only, or undefined when it may. Read by the model. */
export declare const readOnlyRefusal: (access: string | undefined, tool: string) => string | undefined;
