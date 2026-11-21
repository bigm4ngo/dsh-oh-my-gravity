import { posix } from "node:path";
/** DSH's access mode is AGY's session mode: read-only plans, workspace-write runs auto inside `agy acp --sandbox`, and danger-full-access uses `--dangerously-skip-permissions` when configured. */
export const MODE_FOR_ACCESS = {
    "read-only": "plan",
    "workspace-write": "auto",
    "danger-full-access": "auto",
};
export const READ_ONLY_AGY_TOOLS = new Set([
    "read_file", "list_dir", "view_file", "view_file_outline", "view_code_item", "grep_search", "find_by_name",
]);
const SENSITIVE_READ_PATH = /(?:^|\/)(?:\.ssh|\.aws|\.gnupg|\.kube|\.password-store|\.netrc|\.npmrc|\.pypirc|\.docker\/config\.json|id_rsa|id_ed25519|id_ecdsa|etc\/shadow|\.env(?:\.(?!example(?:\/|$)|sample(?:\/|$)|template(?:\/|$))[^/]*)?)(?:\/|$)/;
function isSensitiveReadPath(rawPath) {
    const slashed = rawPath.replace(/\\/g, "/");
    const normalized = posix.normalize(slashed);
    return SENSITIVE_READ_PATH.test(slashed) || SENSITIVE_READ_PATH.test(normalized);
}
/**
 * In `read-only` and `workspace-write`, ordinary reads outside the workspace match native DSH
 * and are auto-allowed unless any target path touches sensitive credential/key locations.
 */
export function isAutoAllowedRead(access, toolName, kind, paths) {
    if (access !== "read-only" && access !== "workspace-write")
        return false;
    if (kind !== "read" || !READ_ONLY_AGY_TOOLS.has(toolName))
        return false;
    if (paths.length === 0)
        return false;
    return paths.every((p) => !isSensitiveReadPath(p));
}
/**
 * DSH's access mode, from the runtime-context message DSH injects each turn: the `sandbox:policy` section of its structured
 * `source`, which only DSH sets. Message text is never read, so a pasted page or a user-authored line cannot claim a
 * mode. The last snapshot wins; with none, or one that does not parse exactly, there is no mode and AGY stays on its default.
 */
export function accessModeOf(messages) {
    let mode;
    for (const message of messages ?? []) {
        const source = message.source;
        if (message.role !== "user" || source?.kind !== "runtime-context" || !Array.isArray(source.sections))
            continue;
        const section = source.sections.find((s) => s?.name === "sandbox:policy");
        const found = typeof section?.text === "string" ? /^Current DSH file policy: ([a-z-]+)\./.exec(section.text) : null;
        if (found)
            mode = found[1];
    }
    return mode;
}
/**
 * DSH tools that only read, so a read-only session may run them. An allowlist on purpose: a tool DSH adds later
 * is refused until someone reads what it does. the list below was checked against DSH's tool packages on 2026-11-10.
 */
export const READ_ONLY_TOOLS = new Set([
    "ask_user_question", "cordis_inspect_list", "cordis_inspect_query", "exit_plan_mode", "get_goal", "job_list", "job_output",
    "list_agents", "list_mcp_resource_templates", "list_mcp_resources", "list_subagent_models", "read_image", "read_mcp_resource",
    "schedule_list", "schedule_view", "session_event_read", "session_event_search", "session_event_trace", "session_search",
    "session_trace", "skill", "team_task_get", "team_task_list", "terminal_list", "terminal_read", "user_terminal_list",
    "user_terminal_read", "wait_agent", "wait_session", "web_fetch", "web_search",
]);
/** Why a DSH tool may not run in a session DSH holds read-only, or undefined when it may. Read by the model. */
export const readOnlyRefusal = (access, tool) => access === "read-only" && !READ_ONLY_TOOLS.has(tool)
    ? "read-only session: this DSH tool can change files or start work, and DSH has this session read-only"
    : undefined;
//# sourceMappingURL=gravity-plan-gate.js.map