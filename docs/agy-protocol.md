# How the plugin talks to AGY

Verified against Antigravity CLI 1.5.13 on Linux, 2026-11. Examples are schematic.

## Why ACP

| | ACP (`agy acp`) | Print (`agy --input-format stream-json --output-format stream-json`) |
| --- | --- | --- |
| Input | JSON-RPC: `initialize`, `session/new`, `session/prompt` | NDJSON `{"event":"user","message":{…}}` |
| Output | `session/update` (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `usage_update`, …) | `init`, `step_update`, `result` |
| Permissions | `session/request_permission` with `allow_once` / `reject_once` | None: a diagnostic on stderr, and the turn still returns `SUCCESS` |
| Cancel | `session/cancel`; the turn ends `cancelled` and the session stays usable | A signal; observed to end the process |

ACP is the only transport where a client can answer permission requests, so it is the one used.

## What the plugin relies on

- **Sessions:** one AGY process per DSH session (`session/new`, then `session/load` to resume a saved conversation after a restart or after the idle reaper stops the process). Replayed history on load is dropped.
- **Modes:** `session/set_mode` with `plan` / `accept-edits` / `auto` / `default`, plus `--dangerously-skip-permissions` on `agy acp` for `danger-full-access` (without calling `session/set_mode`). Observed: in `plan` a write was not made; in `default` a write asked first; `accept-edits` still asked on every `run_command`; in `auto` under `agy acp --sandbox`, workspace edits and sandboxed commands ran unasked while `BypassSandbox: true` and outside-workspace access still asked. When switching between `danger-full-access` and `workspace-write`/`read-only`, the plugin respawns the session process with the right flag and resumes via `session/load`.
- **Models:** `session/new` returns `models.availableModels` (a model at several levels appears as `id-low`, `id-medium`, …) and `_meta.antigravity.tier` (the plan name). `session/set_model` switches. `usage_update.size` is the model's context window after a model is selected.
- **Permissions:** `session/request_permission` carries a `toolCall` with `name`, `kind`, `title`, and optionally `rawInput` / `locations` (also delivered on preceding `tool_call` updates); MCP calls have `kind: "other"`. The plugin auto-allows `danger-full-access`, ordinary non-sensitive `read` tools in `read-only`/`workspace-write`, and bridged `mcp_dsh_*` calls (which enforce `readOnlyRefusal` in `gravity-mcp.ts` and delegate execution to DSH's own tools); all remaining asks build a readable `reason` from `tool_call` / `session/request_permission` metadata for DSH and Auto-Review.
- **MCP:** `mcpServers` on `session/new` / `session/load` accepts an HTTP server with headers; AGY listed its tools and called them, asking permission first. The plugin uses this for DSH's tools.
- **Usage:** prompt replies carry `inputTokens` (already disjoint from cache tokens), `outputTokens`, `cachedReadTokens`, `cachedWriteTokens`, `thoughtTokens`, and `totalTokens`. Multi-step turns sum prompt tokens across internal LLM calls in `result.usage`, so `tokenUsage()` proportionally scales prompt counters down to the turn's latest `usage_update.used` when `promptTotal > used` to keep DSH's context meter accurate.
- **Quota:** ACP does not carry plan quota buckets. Instead, `gravity-quota.ts` launches `agy --settings <tempSettings>` briefly inside a PTY (`python3` `pty.openpty()`) to capture AGY's documented `statusLine` JSON payload (remaining fraction + reset timestamps for Gemini / 3P 5-hour and weekly buckets), exiting on first quota emission without sending prompts or creating conversation files, cached on disk for 5 minutes.

## What AGY does not give a client

- **Deleting a conversation:** `session/close` leaves the conversation file; there is no delete method. Every `session/new` creates a ~400 KB file, so the plugin removes the empty one its own model-list probe creates.
- **Which MCP server a permission request belongs to:** only the tool name (`mcp_<server>_<tool>`).

## Live checks

`tools/gravity-smoke.mjs` (`text`, `approval`, `tools`) and `tools/gravity-rows-smoke.mjs` run the compiled plugin on the installed DSH's runtime against a signed-in `agy`. `approval` makes AGY read a file outside its workspace and checks DSH's real approval service logged and rejected it; `tools` has AGY call a synthetic DSH tool through the bridge.
