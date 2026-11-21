import type { GenerateOptions } from "@deepseek-ai/dsh-llm";

/** DSH's access mode is AGY's session mode: read-only plans, workspace-write accepts edits in the workspace, full access runs auto. */
export const MODE_FOR_ACCESS: Readonly<Record<string, string>> = {
  "read-only": "plan",
  "workspace-write": "accept-edits",
  "danger-full-access": "auto",
};

/**
 * DSH's access mode, from the runtime-context message DSH injects each turn: the `sandbox:policy` section of its structured
 * `source`, which only DSH sets. Message text is never read, so a pasted page or a user-authored line cannot claim a
 * mode. The last snapshot wins; with none, or one that does not parse exactly, there is no mode and AGY stays on its default.
 */
export function accessModeOf(messages: GenerateOptions["messages"] | undefined): string | undefined {
  let mode: string | undefined;
  for (const message of messages ?? []) {
    const source = message.source as { kind?: unknown; sections?: unknown } | undefined;
    if (message.role !== "user" || source?.kind !== "runtime-context" || !Array.isArray(source.sections)) continue;
    const section = (source.sections as { name?: unknown; text?: unknown }[]).find((s) => s?.name === "sandbox:policy");
    const found = typeof section?.text === "string" ? /^Current DSH file policy: ([a-z-]+)\./.exec(section.text) : null;
    if (found) mode = found[1];
  }
  return mode;
}

/**
 * DSH tools that only read, so a read-only session may run them. An allowlist on purpose: a tool DSH adds later
 * is refused until someone reads what it does. the list below was checked against DSH's tool packages on 2026-11-10.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "ask_user_question", "cordis_inspect_list", "cordis_inspect_query", "exit_plan_mode", "get_goal", "job_list", "job_output",
  "list_agents", "list_mcp_resource_templates", "list_mcp_resources", "list_subagent_models", "read_image", "read_mcp_resource",
  "schedule_list", "schedule_view", "session_event_read", "session_event_search", "session_event_trace", "session_search",
  "session_trace", "skill", "team_task_get", "team_task_list", "terminal_list", "terminal_read", "user_terminal_list",
  "user_terminal_read", "wait_agent", "wait_session", "web_fetch", "web_search",
]);

/** Why a DSH tool may not run in a session DSH holds read-only, or undefined when it may. Read by the model. */
export const readOnlyRefusal = (access: string | undefined, tool: string): string | undefined =>
  access === "read-only" && !READ_ONLY_TOOLS.has(tool)
    ? "read-only session: this DSH tool can change files or start work, and DSH has this session read-only"
    : undefined;
