# Oh My Gravity

[English](README.md) · 简体中文

把你已登录的 [Antigravity CLI](https://antigravity.google/docs/cli)（`agy`）当作 [DSH](https://github.com/deepseek-ai/dsh) 里的模型提供方使用：不需要 API key，直接复用 `agy` 已有的登录。

**状态：alpha（`0.1.0-alpha.1`）。** 非官方项目，与 Google 无关。已在 Linux 上使用 AGY 1.5.14 和 DSH 0.2.2-rc.1 测试。

## 功能

- 在 DSH 的模型选择器里列出 AGY 的模型，每个模型一个条目；AGY 提供多档强度的模型（Gemini：low/medium/high/xhigh）会带上强度选择。
- 流式文本与推理过程、token 用量（`Cache hit %`、多步工具循环中按比例换算的上下文环）、上下文窗口、取消，以及 DSH 重启后恢复会话。
- 在 DSH 上下文计量的悬浮提示、上下文弹窗和“设置 → Oh My Gravity”卡片中显示套餐额度（`% left` 和重置倒计时），数据来自 AGY 文档中的 `statusLine` JSON，缓存 5 分钟。
- AGY 的工具活动显示为 DSH 的工具行；AGY 的权限请求通过 DSH 自己的审批设置来回答。
- AGY 可以使用 DSH 的工具（子代理、任务、技能等），每次调用都经 DSH 审批。
- DSH 的访问模式（只读 / 工作区写入 / 完全访问）决定 AGY 自己的模式。
- “设置 → Oh My Gravity”页面：AGY 版本、套餐与登录状态、每个模型的开关、DSH 工具的开关。

## 安装

```
bun install && bun run build
dsh plugin --profile <你的 profile> add "link:/absolute/path/to/dsh-oh-my-gravity"
systemctl --user restart deepseek-harness.service   # 或者你平时重启 DSH 的方式
```

需要先安装并登录 `agy`（在终端里运行一次 `agy`；Antigravity 桌面应用与 CLI 的登录是分开的，在桌面应用里登录不会让 CLI 登录，CLI 登录过期时会提示“Antigravity sign-in required”）。需要 Node ≥ 22.15 和 DSH `>=0.2.2-alpha.2 <0.3.0`。

可选配置，写在 profile 的 `cordis.patch.yml` 中 `oh-my-gravity` 那一行的 `config:` 下：

| 键 | 默认值 | 含义 |
|---|---|---|
| `command` | `agy` | Antigravity CLI 的路径。 |
| `models` | `[]` | 在选择器中提供的模型 id（为空：AGY 报告的全部模型）。AGY 提供多档强度的模型只写不带强度的 id，例如 `gemini-3.8-flash`。 |
| `idleMinutes` | `30` | 会话空闲这么久后停止它的 AGY 进程。每个空闲进程约占 240 MB；下一条消息时会话会自动恢复。 |
| `maxProcesses` | `4` | 同时存活的最多 AGY 进程数；先停止空闲最久的那个。 |

## 工作原理

DSH 为每个 DSH 会话启动一个 `agy acp --sandbox`，并通过 [Agent Client Protocol](https://agentclientprotocol.com) 与它通信。选择 ACP 而不是 `agy -p`，是因为只有 ACP 会把权限请求发给客户端（见 [docs/agy-protocol.md](docs/agy-protocol.md)）。`agy` 只会拿到一份很小的环境变量白名单，不会拿到 DSH 的提供方密钥。

## 权限与安全

- **DSH 的访问模式逐轮控制 AGY：**
  - `read-only` → `agy acp --sandbox`，模式 `plan`（工作区外的普通读取会像原生 DSH 一样自动放行，除非涉及敏感凭据路径，如 `.ssh`、`.aws`、`.gnupg`、`.env` 等）。
  - `workspace-write` → `agy acp --sandbox`，模式 `auto`（工作区内的编辑、沙箱内的 shell 命令和工作区外的普通读取都不再询问；工作区外的写入/编辑、带 `BypassSandbox: true` 的非沙箱命令、网络提权以及敏感凭据读取仍会带着命令或路径询问 DSH）。
  - `danger-full-access` → `agy acp --dangerously-skip-permissions`（在切入或切出完全访问时通过 `session/load` 无缝重启）。
  模式只从 DSH 运行时上下文消息的结构化 `source` 字段读取，从不从消息文本推断，所以粘贴的网页或手打的文字无法冒充它。没有声明模式时，AGY 保持默认（`--sandbox`）。如果 AGY 缺少会话所需的模式，这一轮会失败，而不是无限制地运行。
- **审批归 DSH 管：** 每个未被访问模式自动放行的 AGY 权限请求都会带着命令、文件路径或参数说明交给 DSH 的审批服务。桥接的 DSH 工具（`mcp_dsh_*`）会把 AGY 的权限询问推迟，并执行 DSH 自己的只读计划门禁（`readOnlyRefusal`）；DSH 工具本身直接运行，不再多一层桥接提示，与原生 DSH 一致。插件没有任何可以跳过提示的设置。
- **只读会话会拒绝会改变状态的 DSH 工具**，使用只读白名单。
- **DSH 只对 AGY 主动询问的部分做门禁。** AGY 会自动放行一些操作（例如 `/tmp` 下的读取不需要权限），而 `~/.gemini/antigravity-cli/settings.json` 是 AGY 自己的策略。权限被拒绝会终止 AGY 的这一轮；插件随后会补一行说明是哪个权限。
- DSH 工具桥接在 `[IP_ADDRESS]` 的随机端口上监听，每个会话有一把在会话的 AGY 进程结束时立即作废的密钥。设置路由会拒绝跨域请求和非 JSON 写入，边接收边限制请求体大小，并依赖 DSH 自己的登录状态。

## 插件会写入的文件

- `~/.local/state/dsh-oh-my-gravity/`（可用 `DSH_GRAVITY_STATE_DIR` 覆盖）：`settings.json`（页面上的选择）、`catalog.json`（最近一次可用的模型列表和套餐，避免重启或 AGY 启动慢时选择器变空）、`sessions.json`（DSH 会话 → AGY 对话，用于恢复）。
- AGY 把每个会话保存为 `~/.gemini/antigravity-cli/conversations/` 下的对话文件，且不提供通过 ACP 删除会话的方法。插件会开一个一次性会话读取模型列表（最多每 10 分钟一次）；这个会话从不发送提示，插件会删除它留下的空对话文件。真正的 DSH 会话的对话文件不会被删除，因为恢复需要它们。
- 诊断用的日志行：`journalctl --user -u deepseek-harness.service | grep dsh-oh-my-gravity` 会显示每次调用的用途和耗时、每个会话的 DSH 访问模式 → AGY 模式、每个转发的权限请求以及由谁回答，以及模型列表失败的原因。

## 不支持

- **带工具调用的轮次里的 `tok/s`，以及按工具统计的步骤数。** 因为 AGY 在 DSH 的一次 `stream()` 步骤内运行自己的工具循环，DSH 每轮只记一个步骤，而不是每个内部工具调用一个；另外 DSH 的 `dsh-session-stats` 会在第一条 `assistant/message` 行（DSH v4 会话校验要求的合成工具调用公告）出现时关闭 `openStep`，所以 `tok/s` 和 TTFT 只在非工具轮次记录。
- **费用行。** AGY 报告 token 而不是价格，DSH 的用量记录也没有费用字段。
- **Claude 面板相关功能**（rewind、memory、skills、MCP 与 asides 面板、SSH 盒子、面板 UI）：它们依赖 AGY 没有暴露的 Claude Code 内部结构，所以被删除，而不是半移植。
- **DSH 的文件和 shell 工具**不会提供给 AGY（它有自己的）。DSH 工具没有中断接线：取消 AGY 的一轮不会停止已经在运行的 DSH 工具。
- 只转发文本（不转发图片或音频）。Windows 和 macOS 未测试。

## 故障排查

- **一轮结束后比回复晚约 20 秒才结束。** 那是 DSH 自己的 `dsh-workspace-changes` 在用 git 给工作区做快照。如果你的工作区位于一个很大的 git 仓库里（例如位于 `~` 的仓库），就可能要这么久；插件本身在日志显示的时间点就已经完成了。
- **没有 Oh My Gravity 提供方：** 在日志里查找 `did not activate`；提供方 id 是 `antigravity`，所以另一个注册该 id 的插件（例如某个订阅插件）会冲突。

## 开发

```
bun install && bun run typecheck && bun run build && bun run test
```

单元测试通过真实管道驱动真实代码，对着一个假的 `agy` 运行。实机检查需要已登录的 `agy` 和已安装的 DSH：

```
node tools/gravity-smoke.mjs /abs/path/to/dsh/package.json text
GRAVITY_SMOKE_DIR=<non-temp dir> node tools/gravity-smoke.mjs /abs/path/to/dsh/package.json approval
GRAVITY_SMOKE_DIR=<non-temp dir> node tools/gravity-smoke.mjs /abs/path/to/dsh/package.json tools
node tools/gravity-rows-smoke.mjs /abs/path/to/dsh/package.json
```

设置页面的客户端没有自动化测试，只在 DSH Web 里手工验证过。
