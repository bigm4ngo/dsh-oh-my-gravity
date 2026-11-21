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
- **Modes:** `session/set_mode` with `plan` / `accept-edits` / `auto` / `default`. Observed: in `plan` a write was not made, in `default` a write asked first, in `accept-edits` and `auto` it was made unasked.
- **Models:** `session/new` returns `models.availableModels` (a model at several levels appears as `id-low`, `id-medium`, …) and `_meta.antigravity.tier` (the plan name). `session/set_model` switches. `usage_update.size` is the model's context window after a model is selected.
- **Permissions:** `session/request_permission` carries a `toolCall` with `name`, `kind` and `title`; MCP calls have `kind: "other"`.
- **MCP:** `mcpServers` on `session/new` / `session/load` accepts an HTTP server with headers; AGY listed its tools and called them, asking permission first. The plugin uses this for DSH's tools.
- **Usage:** prompt replies carry `inputTokens`, `outputTokens`, `cachedReadTokens`, `cachedWriteTokens`, `thoughtTokens`, `totalTokens`.

## What AGY does not give a client

- **Quota / credits:** not in the ACP stream. `/usage` is TUI-only; the documented `statusLine` command (which receives quota buckets) did not fire under `agy acp` in a test.
- **Deleting a conversation:** `session/close` leaves the conversation file; there is no delete method. Every `session/new` creates a ~400 KB file, so the plugin removes the empty one its own model-list probe creates.
- **Which MCP server a permission request belongs to:** only the tool name (`mcp_<server>_<tool>`).

## Live checks

`tools/gravity-smoke.mjs` (`text`, `approval`, `tools`) and `tools/gravity-rows-smoke.mjs` run the compiled plugin on the installed DSH's runtime against a signed-in `agy`. `approval` makes AGY read a file outside its workspace and checks DSH's real approval service logged and rejected it; `tools` has AGY call a synthetic DSH tool through the bridge.
