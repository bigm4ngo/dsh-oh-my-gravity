# Oh My Gravity

Run your signed-in [Antigravity CLI](https://antigravity.google/docs/cli) (`agy`) as a model provider inside [DSH](https://github.com/deepseek-ai/dsh): no API key, the login `agy` already has.

**Status: alpha (`0.1.0-alpha.1`).** Unofficial and not affiliated with Google. Tested on Linux with AGY 1.5.13 and DSH 0.2.2-rc.1.

## What you get

- AGY's models in DSH's picker, one entry per model, with the effort chooser for models AGY ships at several levels (Gemini: low/medium/high/xhigh).
- Streaming text and reasoning, token usage, context windows, cancel, and resume after a DSH restart.
- AGY's tool activity as DSH tool rows, and AGY's permission requests answered through DSH's own approval setting.
- DSH's tools (subagents, jobs, skills, …) available to AGY, each call approved through DSH.
- DSH's access mode (read-only / workspace-write / full access) driving AGY's own mode.
- A Settings → Oh My Gravity page: AGY version, plan and sign-in, a switch per model, a switch for DSH's tools.

## Install

```
bun install && bun run build
dsh plugin --profile <your-profile> add "link:/absolute/path/to/dsh-oh-my-gravity"
systemctl --user restart deepseek-harness.service   # or however you restart DSH
```

You need `agy` installed and signed in (`agy` once interactively). Requires Node ≥ 22.15 and DSH `>=0.2.2-alpha.2 <0.3.0`.

Optional keys, as `config:` on the `oh-my-gravity` row in the profile's `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `command` | `agy` | Path to the Antigravity CLI. |
| `models` | `[]` | Model ids to offer in the picker (empty: all AGY reports). A model AGY ships at several levels has one id without the level, e.g. `gemini-3.8-flash`. |
| `idleMinutes` | `30` | Stop a session's AGY process after this long idle. Each idle process holds about 240 MB; the conversation resumes on the next message. |
| `maxProcesses` | `4` | Most AGY processes alive at once; the longest idle is stopped first. |

## How it works

DSH starts `agy acp --sandbox` per DSH session and talks to it over the [Agent Client Protocol](https://agentclientprotocol.com). ACP is used instead of `agy -p` because only ACP sends permission requests to the client (see [docs/agy-protocol.md](docs/agy-protocol.md)). `agy` gets a small environment allowlist, not DSH's provider keys.

## Permissions and safety

- **DSH's access mode sets AGY's mode each turn:** read-only → `plan`, workspace-write → `accept-edits`, full access → `auto` (AGY's closest mode; it still asks before irreversible actions). The mode is read from the structured `source` of DSH's runtime-context message, never from message text, so a pasted page or a typed line cannot claim one. With none stated, AGY stays on its default. If AGY lacks a mode a session needs, the turn fails rather than running unrestricted.
- **Approvals are DSH's:** every AGY permission request goes to DSH's approval service, and every DSH tool AGY calls is checked by the bridge itself (with its arguments shown in full; calls with over 4000 characters of arguments are refused). The plugin has no setting that waives prompts. A DSH tool call can therefore prompt twice: once for AGY's request, once for the bridge.
- **A read-only session refuses DSH tools that can change things** , using a read-only allowlist..
- **DSH only gates what AGY asks about.** AGY auto-allows some things (a read under `/tmp` needed no permission), and `~/.gemini/antigravity-cli/settings.json` is AGY's own policy. A refused permission ends AGY's turn; the plugin then adds a line naming it.
- The DSH-tools bridge listens on `127.0.0.1` on a random port with a per-session key that is revoked when the session's AGY process ends. The Settings routes refuse cross-origin requests and non-JSON writes, cap bodies as they stream, and rely on DSH's own sign-in.

## Files the plugin touches

- `~/.local/state/dsh-oh-my-gravity/` (override with `DSH_GRAVITY_STATE_DIR`): `settings.json` (page choices), `catalog.json` (last good model list and plan, so a restart or slow AGY start does not empty the picker), `sessions.json` (DSH session → AGY conversation, for resume).
- AGY keeps every session as a conversation file in `~/.gemini/antigravity-cli/conversations/` and offers no way to delete one over ACP. The plugin opens a throwaway session to read the model list (at most every 10 minutes); that session is never prompted, and the plugin removes its empty conversation file. Real DSH sessions' conversations are left alone, since resume needs them.
- Journal lines for diagnosis: `journalctl --user -u deepseek-harness.service | grep dsh-oh-my-gravity` shows each call's purpose and duration, each session's DSH access mode → AGY mode, each relayed permission request and who answered it, and model-list failures.

## Not supported

- **Usage and quota.** AGY exposes nothing equivalent to a client: `/usage` is a terminal panel, the `statusLine` hook that carries quota does not run under `agy acp`, and the ACP stream has no quota fields. Settings shows your plan name (e.g. "Google AI Pro") and DSH's context ring shows tokens, but not remaining quota. Reading Google's undocumented endpoints was not attempted.
- **Cost rows.** AGY reports tokens, not prices, and DSH's usage record has no cost field.
- **Claude panel features** (rewind, memory, skills, MCP and asides panels, SSH boxes, a panel UI): they depended on Claude Code internals AGY does not expose, so they were removed rather than half-ported.
- **DSH file and shell tools** are not served to AGY (it has its own). DSH tools run with no abort wiring: cancelling an AGY turn does not stop a DSH tool already running.
- Only text is forwarded (no images or audio). Windows and macOS are untested.

## Troubleshooting

- **A turn takes ~20 s longer to end than the reply did.** That is DSH's own `dsh-workspace-changes` snapshotting your workspace with git. If your workspace sits inside a huge git repo (for example a repository at `~`), it can take that long; the plugin itself finished in the time the journal shows.
- **No Oh My Gravity provider:** check the journal for `did not activate`; the provider id is `antigravity`, so another plugin registering that id (for example a subscriptions plugin) will clash.

## Development

```
bun install && bun run typecheck && bun run build && bun run test
```

Unit tests drive the real code over real pipes against a fake `agy`. Live checks need a signed-in `agy` and an installed DSH:

```
node tools/gravity-smoke.mjs /abs/path/to/dsh/package.json text
GRAVITY_SMOKE_DIR=<non-temp dir> node tools/gravity-smoke.mjs /abs/path/to/dsh/package.json approval
GRAVITY_SMOKE_DIR=<non-temp dir> node tools/gravity-smoke.mjs /abs/path/to/dsh/package.json tools
node tools/gravity-rows-smoke.mjs /abs/path/to/dsh/package.json
```

The Settings page client has no automated test; it was checked by hand in DSH Web.
