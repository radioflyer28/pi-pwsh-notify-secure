# pi-pwsh-notify-secure

Security-hardened fork of [oversk7/pi-pwsh-notify](https://github.com/oversk7/pi-pwsh-notify). Release `0.5.0-secure.5` selectively adapts upstream 0.5.0 reliability work without adopting its weaker executable resolution, execution-policy override, automatic output disclosure, or default complete-output logs.

English | [中文说明](#中文说明)

Trusted PowerShell shell for [pi](https://pi.dev) on Windows (PowerShell 7 preferred, Windows PowerShell fallback), with **Claude Code-style background jobs that auto-notify the agent on completion** — no polling.

```
pi install git:github.com/radioflyer28/pi-pwsh-notify-secure@v0.5.0-secure.5
```

## Why

Pi 0.84.3 introduced an optional native `powershell` tool for ordinary foreground commands. This package remains focused on two gaps:

1. Native Pi has no managed background jobs, persistent `cd`, blocking job wait, or ready/finished steering notifications.
2. The native implementation examined at Pi 0.84.3 used unqualified executable discovery and cleanup helpers; this fork uses verified absolute executable paths and does not force `-ExecutionPolicy Bypass`.

The peer floor remains Pi/TUI 0.84.3 after type-checking against that release. Development, integration tests, and extension smoke loading target Pi/TUI 0.87.1. See the [source-by-source Pi comparison](docs/research/pi-0.84.3-native-powershell.md), the [upstream 0.5.0 secure-adaptation matrix](docs/research/upstream-0.5.0-secure-adaptation.md), and the [upstream synchronization checklist](docs/maintenance/upstream-sync.md).

### Symptoms this fixes

If you have hit any of these running pi on Windows, this package is the fix:

- pi **hangs / gets stuck** after the agent runs `npm run dev`, `vite`, a dev server, or any long-running command — the session never comes back
- a background process started with `&` **blocks the whole session**
- **Chinese / Japanese / non-ASCII output shows up garbled** (mojibake, `???` or `锟斤拷`) in tool output
- Windows paths get **mangled by Git Bash / MSYS path conversion** (`C:\Users\...` rewritten into `/c/Users/...` or worse)
- the agent starts a background job, then **polls its status in a loop**, burning tokens while it waits

This extension fixes both. The agent starts a build or dev server in the background, keeps chatting with you, and **when the process exits, a metadata-only notification with the exit status and runtime is automatically injected into the conversation**. Command text and process output stay behind the explicit `pwsh_job` boundary, so untrusted output cannot become an autonomous steering message.

Delivery also mirrors Claude Code's mechanics, built on pi's official steering channel (`deliverAs: "steer"`):

- **Agent mid-turn** → pi injects the notification **before the agent's next LLM call**, so the model learns "server is up" or "job failed" within seconds, while it is still working — instead of receiving stale news after the turn ends (`followUp`), when it has often already discovered (and handled) the outcome itself.
- **Agent idle** → `triggerTurn` wakes it immediately.
- **Bounded batching and retries** → job events are debounced (250 ms), split into bounded item/character batches, retried only a finite number of times, and reported locally if delivery is ultimately dropped.
- A ready or finished state explicitly observed through `pwsh_job output`/`wait` cancels the matching queued notification, preventing redundant model turns.

Because notifications are *custom* messages/entries rather than fake user messages, the TUI shows a compact one-line status row instead of a wall of text in a `User` box. The LLM receives only the job id, status, and runtime; it must retrieve output explicitly when relevant.

## Tools

Two tools, Claude Code-shaped: background execution is a parameter, not a separate tool.

| Tool | Purpose |
| --- | --- |
| `pwsh` | Run a command (replaces built-in `bash`). `run_in_background: true` starts a job that **auto-notifies on exit**; `notify_on` (regex) adds a **ready notification** for servers that never exit |
| `pwsh_job` | Background job management: incremental output / **blocking wait** (Claude Code's Monitor) / list / kill (`taskkill /T /F`) |

### Tool display

Both `pwsh` and `pwsh_job` use purpose-built TUI rendering. Collapsed `pwsh` calls retain the beginning of the command, while collapsed `pwsh_job` calls identify the action, job id, and relevant options. Result previews retain the newest five visual lines and show how much earlier content is hidden. Expanding tool output displays the complete invocation and all text retained in the tool result; it cannot recover output already bounded by execution limits.

Expansion uses Pi's configurable `app.tools.expand` action (`Ctrl-O` by default), so custom keybindings are honored automatically. Display rendering is UI-only and does not alter tool arguments, result content/details, conversation messages, or model context. Completed rows cache their width-specific presentation so ordinary TUI redraws do not repeatedly re-wrap retained output.

### Foreground `pwsh`

- **`cd` persists between calls** (tracked by the extension); variables and functions do not — each call is a fresh `pwsh -NoProfile -NonInteractive` process
- Commands are transported as BOM-less UTF-8 over stdin through a fixed bootstrap, avoiding Windows command-line length and quoting limits
- Per-stream UTF-8 decoders preserve multibyte characters split across process chunks; CRLF and bare carriage returns are normalized before TUI/model output
- Default 120s timeout (overridable per call); timeout or cancellation requests whole-process-tree termination, and cleanup failures are reported rather than claimed as successful kills
- A trailing `&` is rejected with a pointer to `run_in_background` — a PowerShell job would die silently with the wrapper process
- Nonzero exits, timeouts, cancellation, spawn failures, and cleanup failures produce **failed tool results**, with retained output and structured execution details; a later successful command is not marked as a stale failure
- Foreground capture keeps at most 400,000 UTF-16 code units (not a complete transcript); final results additionally use Pi's standard byte/line limits. Cwd control records are parsed separately, so retention rollover cannot discard a directory change
- Live foreground previews are coalesced to one update per 100ms, with a final dirty update flushed at completion

### Background (`run_in_background: true`)

- Returns immediately with a job id; output stays in a bounded in-memory tail (last 400,000 UTF-16 code units) with absolute cursors and explicit warnings if unseen data rolls out
- On exit, a metadata-only `<background-job-finished>` notification (job id, status, runtime) is injected into the session; command and output text are intentionally omitted
- **`notify_on` regex** — for processes that never exit (dev servers, watchers): the first output match injects a one-time metadata-only `<background-job-ready>` notification, so "server is up" also arrives without polling (e.g. `notify_on: "Local:.*http"` for vite)
- Rendered in the TUI as a single status row — `● bg job bg-1 (pytest) · exited 0 · 7s`; inspect output explicitly through `pwsh_job` or the job viewer
- **Footer status** while jobs are alive — `1 bg job running` in pi's status bar, like Claude Code's "1 shell running"; clears when the last job exits
- `pwsh_job` output is **incremental**: each check returns only output produced since the previous one — repeated peeks don't re-burn tokens
- **`pwsh_job wait`** — Claude Code's Monitor tool: blocks until the job's unseen output matches a `pattern` regex, or the job exits, or `timeout` seconds pass (default 120). The one legitimate way to *wait* for a job when the agent cannot proceed without the result — replaces polling loops entirely
- Optional `timeout` to kill runaway jobs; jobs killed via `pwsh_job` do not notify
- **Job viewer (Claude Code style)** — while jobs run, a live list sits below the input box: press `→` (or `Tab`) at an empty prompt to focus it, `↑`/`↓` to select a job, `Enter` to open its **live output overlay** (scrollable, auto-follows new output, `PgUp`/`PgDn`/`Home`/`End`), and press `x` twice to **kill the job** from the overlay. (`↓`/`←` are intentionally left to pi-subagents' fleet view, so both lists can be shown and entered at once)
- Jobs belong to the session: they are reaped when it ends — pi exiting (including **closing the terminal window**: SIGHUP/SIGBREAK/SIGTERM are handled, not just graceful exit), `/reload`, or switching sessions (`/new`, `/resume`, `/fork`) — and shutdown waits only for a bounded settlement interval
- Complete command output is **not written to temporary or persistent log files by default**; output is available only through explicit bounded tool results, the live viewer, and the in-memory tail

### Shared execution and timeout semantics

Foreground, background, and `!`/`!!` execution share the same process lifecycle, independent stdout/stderr decoders, bounded output retention, and cancellation handling. `!`/`!!` output streams immediately to Pi; user-shell calls share the foreground cwd queue.

All timeouts are **seconds**, including the `BashOperations` adapter. Omitted timeouts mean 120 seconds for foreground `pwsh` and `pwsh_job wait`, unlimited for background and user-shell operations. Explicit `0` means unlimited. Negative, nonfinite, and values above `2147483.647` seconds are rejected before launch/wait; positive sub-millisecond values round up to 1ms. A wait timeout does not stop the job.

When a shell exits but a descendant holds stdout/stderr open, capture settles after **250ms of pipe inactivity**, restarting that grace period on every output chunk. Normal EOF finishes immediately. Explicit results warn if capture ended with open pipes; late output after that boundary may be lost. A managed job represents the original shell, not every independently detached descendant. Keep servers in the foreground of the managed shell rather than daemonizing them. Continuous post-exit output keeps capture active, but an explicit execution timeout or cancellation still stops capture. After the parent exits, stopping capture cannot guarantee termination of independently detached descendants; it does not target the now-stale parent PID.

The shared runner never writes output logs. **Pi itself owns the `!`/`!!` output consumer** and Pi 0.87.1 may spill large user-shell output to temporary `pi-bash-*.log` files. Use `pwsh`/`pwsh_job` when the extension's no-complete-output-log behavior is required. Normal Pi conversation persistence still applies to returned tool output.

## Built-in tool handling

- When a trusted runtime is available, built-in `bash` and native `powershell` are removed from the active tool list (`pwsh` replaces both), preventing competing shell surfaces.
- Pi's `!` and `!!` editor shortcuts execute through the same trusted PowerShell runtime and persistent working directory.
- If no trusted PowerShell runtime is available, `pwsh`/`pwsh_job` are deactivated and Pi's built-in shell tools remain available.
- Built-in `grep`/`find` are removed **only when** [pi-fff](https://www.npmjs.com/package/@ff-labs/pi-fff)'s `ffgrep`/`fffind` are present to take over searching. Without pi-fff, nothing else is touched.
- Removal re-runs on every session/agent start, so it also covers renderer extensions (e.g. pi-claude-style-tools) that re-register the default-hidden built-ins as a side effect.

## Comparison

| | pi-pwsh-notify-secure | Pi 0.84.3 native | @4fu/pi-pwsh | pi-powershell | @marcfargas/pi-powershell |
| --- | --- | --- | --- | --- | --- |
| Foreground PowerShell | ✅ | ✅ | ✅ | translation layer over bash | ✅ (adds tool) |
| Background jobs | ✅ | ❌ | via `Start-Job` | user commands only | ✅ |
| **Agent auto-notified on completion** | ✅ (metadata only) | ❌ | ❌ (agent must poll) | ❌ | ❌ (agent must poll) |
| **Ready notification for never-exiting servers** (`notify_on`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Mid-turn delivery + batching** (steered before the next LLM call; co-finishers merged into one message) | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Blocking wait on pattern/exit** (Claude Code's Monitor) | ✅ | ❌ | ❌ | ❌ | ❌ |
| `cd` persists between calls | ✅ | ❌ | ❌ | ❌ | ❌ |
| Absolute PowerShell / `taskkill.exe` resolution | ✅ | ❌ | — | — | — |

## Requirements

- Pi/TUI 0.84.3 or newer on Windows; Pi/TUI 0.87.1 is the development and smoke-test target.
- PowerShell 7 (`pwsh`) is preferred — install with `winget install Microsoft.PowerShell`. Trusted Windows PowerShell 5.1 is retained as a fallback.

## Security hardening

- PowerShell and `taskkill.exe` are launched only by verified absolute path. Empty and relative `PATH` entries are ignored, and no `where.exe` subprocess is used, preventing current-directory executable hijacking in untrusted repositories.
- Automatic ready/finished steering messages contain metadata only. Commands, matched lines, stdout/stderr, and log paths are omitted; output must be retrieved explicitly and is identified to the agent as untrusted data.
- Shells run with `-NoProfile -NonInteractive`; this fork does not force `-ExecutionPolicy Bypass`.
- `pwsh`/`pwsh_job` and the shared runner create no full-output temporary logs. Pi's own `!`/`!!` consumer has separate retention behavior, described above.

## Notes

- Each `pwsh` call is a fresh process: variables and functions do not persist between calls. `cd` *does* persist — the extension tracks the final working directory of every call.
- Provided as-is; issues and PRs welcome but response times are not guaranteed.

---

## 中文说明

Windows 下给 [pi](https://pi.dev) 用的 PowerShell 7 shell，带 Claude Code 风格的后台任务：**任务结束后自动通知 agent，无需轮询**。

```
pi install git:github.com/radioflyer28/pi-pwsh-notify-secure@v0.5.0-secure.5
```

### 它解决的问题

在 Windows 上用 pi 时遇到过以下任何一条，装它就对了：

- pi 内置的 `bash` 工具走 Git Bash（MSYS），agent 一运行 `npm run dev` 等常驻/后台进程，**整个会话就卡死挂起**，再也不回来
- 工具输出里的**中文乱码**（`???`、`锟斤拷`），Windows 路径被 MSYS 路径转换弄坏
- 已有的 PowerShell 扩展虽然能开后台任务，但要 agent **反复轮询状态**，白白烧 token

### 工作方式

agent 在后台启动构建或 dev server 后可以继续和你对话；进程退出时，一条只包含任务 ID、退出状态和运行时间的 `<background-job-finished>` 元数据通知会**自动注入会话**。命令和进程输出不会自动进入 steering 消息；agent 只有在确有需要时才通过 `pwsh_job` 显式读取，并将其视为不可信数据。对 dev server 这类**永不退出**的进程，传一个 `notify_on` 正则（如 `"Local:.*http"`），输出首次匹配时注入一条同样只含元数据的 `<background-job-ready>` 就绪通知。

通知的投递方式也复刻了 Claude Code，底层用的是 pi 官方的 steering 通道（`deliverAs: "steer"`）：**agent 正在工作时**，通知在它**下一次 LLM 调用前**注入——模型几秒内就知道"服务起来了/任务失败了"，而不是等回合结束（`followUp` 的行为）才收到一条它早已自己发现并处理过的过期消息；**agent 空闲时**由 `triggerTurn` 立即唤醒。事件先经 250ms 去抖**合并成一条消息**再发——pi 的 steering 队列每次 LLM 调用只投一条，不合并的话 N 个同时结束的任务就要多花 N 次调用。正在被 `pwsh_job wait` 阻塞等待的任务退出时，结果由 wait 的返回值直接带回，多余的结束通知会被抑制。TUI 里通知渲染成一行紧凑的状态行（`● bg job bg-1 (pytest) · exited 0 · 7s`），不会刷屏。有后台任务存活时，pi 状态栏还会显示 `1 bg job running`（对应 Claude Code 的 "1 shell running"），最后一个任务退出后自动消失。

### 工具

只有两个工具，形状和 Claude Code 一致——后台执行是参数，不是单独的工具。

| 工具 | 用途 |
| --- | --- |
| `pwsh` | 执行命令（替换内置 `bash`）；`run_in_background: true` 启动后台任务并**在退出时自动通知**，`notify_on` 正则为常驻进程加**就绪通知** |
| `pwsh_job` | 后台任务管理：增量输出 / **阻塞等待**（对应 Claude Code 的 Monitor：等输出匹配正则或进程退出）/ 列表 / 杀掉整棵进程树 |

两个工具都有专用 TUI 显示：折叠时保留命令开头或任务操作摘要，并显示结果最新五个可视行；展开后显示工具结果中仍保留的全部文本。展开沿用 Pi 可配置的 `app.tools.expand` 动作（默认 `Ctrl-O`），不会注册扩展自己的快捷键，也不会更改传给模型的参数、结果或会话消息。

前台 `pwsh`：**`cd` 在调用之间持久**（变量/函数不持久，每次都是全新 `pwsh -NoProfile -NonInteractive` 进程）；命令通过固定 bootstrap 以无 BOM UTF-8 从 stdin 传入，不受 Windows 命令行长度和嵌套引号限制；默认 120 秒超时并清理整棵进程树；结尾 `&` 会被拦截并提示改用后台参数。`pwsh_job` 的输出是**增量且有界的**——每次只返回上次检查之后的新输出，`lines: 0` 也受 Pi 标准字节/行数限制；内存尾部滚动导致未读数据丢失时会明确警告。默认不会把完整命令输出写入临时日志。

有任务在跑时，输入框下方会出现一个**可进入的任务列表**（Claude Code 风格）：空提示符按 `→`（或 `Tab`）进入，`↑`/`↓` 选择任务，`Enter` 打开**实时输出面板**——可滚动、自动跟随新输出（`PgUp`/`PgDn`/`Home`/`End`），在面板里连按两次 `x` 直接**杀掉任务**。（`↓`/`←` 故意留给 pi-subagents 的 fleet 列表，两个列表可以同时显示、各自进入。）任务属于当前会话：会话结束时（pi 退出——包括**直接关掉终端窗口**，SIGHUP/SIGBREAK/SIGTERM 都已处理；或 `/reload`、`/new`、`/resume`、`/fork` 切换会话）残留任务会被统一回收，不留孤儿 dev server 占着端口。

### 要求

Pi/TUI 0.84.3 或更高版本，运行于 Windows；开发与 smoke test 目标为 0.87.1。建议 PowerShell 7（`winget install Microsoft.PowerShell`），未安装时保留可信的 Windows PowerShell 5.1 回退。`!`/`!!` 也会使用同一安全 PowerShell runtime；若找不到可信 runtime，本扩展工具停用并保留 Pi 内置 shell。

## License

MIT
