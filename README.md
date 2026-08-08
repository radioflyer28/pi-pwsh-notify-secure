# pi-pwsh-notify

English | [中文说明](#中文说明)

PowerShell 7 shell for [pi](https://pi.dev) on Windows, with **Claude Code-style background jobs that auto-notify the agent on completion** — no polling.

```
pi install npm:pi-pwsh-notify
```

## Why

Two problems with running pi on Windows:

1. The built-in `bash` tool runs through Git Bash (MSYS), which mangles Windows paths, garbles non-ASCII output, and **hangs the whole session** on background processes (`npm run dev &`).
2. Even with a PowerShell extension, existing packages make the agent *poll* for background job status. There is no way for a finished job to wake the agent up.

### Symptoms this fixes

If you have hit any of these running pi on Windows, this package is the fix:

- pi **hangs / gets stuck** after the agent runs `npm run dev`, `vite`, a dev server, or any long-running command — the session never comes back
- a background process started with `&` **blocks the whole session**
- **Chinese / Japanese / non-ASCII output shows up garbled** (mojibake, `???` or `锟斤拷`) in tool output
- Windows paths get **mangled by Git Bash / MSYS path conversion** (`C:\Users\...` rewritten into `/c/Users/...` or worse)
- the agent starts a background job, then **polls its status in a loop**, burning tokens while it waits

This extension fixes both. The agent starts a build or dev server in the background, keeps chatting with you, and **when the process exits, a notification with the exit code and output tail is automatically injected into the conversation** — the agent wakes up and reacts, exactly like background tasks in Claude Code.

Delivery also mirrors Claude Code's mechanics, built on pi's official steering channel (`deliverAs: "steer"`):

- **Agent mid-turn** → pi injects the notification **before the agent's next LLM call**, so the model learns "server is up" or "job failed" within seconds, while it is still working — instead of receiving stale news after the turn ends (`followUp`), when it has often already discovered (and handled) the outcome itself.
- **Agent idle** → `triggerTurn` wakes it immediately.
- **Batching** → job events are debounced (250 ms) and merged into **one message**. This matters because pi's steering queue drains one message per LLM call: without merging, N jobs finishing together would cost N calls.
- A job that exits while a `pwsh_job wait` is blocked on it is reported by the wait's own return value; the redundant finished notification is suppressed.

Because notifications are *custom* messages/entries rather than fake user messages, the TUI shows a compact one-line status row instead of a wall of text in a `User` box — while the LLM still receives the full tagged notification.

## Tools

Two tools, Claude Code-shaped: background execution is a parameter, not a separate tool.

| Tool | Purpose |
| --- | --- |
| `pwsh` | Run a command (replaces built-in `bash`). `run_in_background: true` starts a job that **auto-notifies on exit**; `notify_on` (regex) adds a **ready notification** for servers that never exit |
| `pwsh_job` | Background job management: incremental output / **blocking wait** (Claude Code's Monitor) / list / kill (`taskkill /T /F`) |

### Foreground `pwsh`

- **`cd` persists between calls** (tracked by the extension); variables and functions do not — each call is a fresh `pwsh -NoProfile -NonInteractive` process
- Commands are passed via `-EncodedCommand` — **nested quoting never breaks**
- UTF-8 forced on both PowerShell and Python child processes — non-ASCII output renders correctly
- Default 120s timeout (overridable per call); the whole process **tree** is killed on timeout, with a hint to rerun with `run_in_background` if it looks like a server
- A trailing `&` is rejected with a pointer to `run_in_background` — a PowerShell job would die silently with the wrapper process
- Native exit codes survive the `-Command` flattening (`exit $LASTEXITCODE` re-raise)
- Live output streaming while the command runs

### Background (`run_in_background: true`)

- Returns immediately with a job id; output captured in memory (last 400 KB)
- On exit, a `<background-job-finished>` notification (status, runtime, last 60 output lines) is injected into the session
- **`notify_on` regex** — for processes that never exit (dev servers, watchers): the first output match injects a one-time `<background-job-ready>` notification, so "server is up" also arrives without polling (e.g. `notify_on: "Local:.*http"` for vite)
- Rendered in the TUI as a single tool-result-like row — `● bg job bg-1 (pytest) · exited 0 · 7s` plus the last few output lines; expand the message to see the full tail
- **Footer status** while jobs are alive — `1 bg job running` in pi's status bar, like Claude Code's "1 shell running"; clears when the last job exits
- `pwsh_job` output is **incremental**: each check returns only output produced since the previous one — repeated peeks don't re-burn tokens
- **`pwsh_job wait`** — Claude Code's Monitor tool: blocks until the job's unseen output matches a `pattern` regex, or the job exits, or `timeout` seconds pass (default 120). The one legitimate way to *wait* for a job when the agent cannot proceed without the result — replaces polling loops entirely
- Optional `timeout` to kill runaway jobs; jobs killed via `pwsh_job` do not notify
- **Job viewer (Claude Code style)** — while jobs run, a live list sits below the input box: press `→` (or `Tab`) at an empty prompt to focus it, `↑`/`↓` to select a job, `Enter` to open its **live output overlay** (scrollable, auto-follows new output, `PgUp`/`PgDn`/`Home`/`End`), and press `x` twice to **kill the job** from the overlay. (`↓`/`←` are intentionally left to pi-subagents' fleet view, so both lists can be shown and entered at once)
- Jobs belong to the session: they are reaped when it ends — pi exiting (including **closing the terminal window**: SIGHUP/SIGBREAK/SIGTERM are handled, not just graceful exit), `/reload`, or switching sessions (`/new`, `/resume`, `/fork`) — so no invisible orphan dev servers keep listening on their ports

## Built-in tool handling

- Built-in `bash` is removed from the active tool list (pwsh replaces it).
- Built-in `grep`/`find` are removed **only when** [pi-fff](https://www.npmjs.com/package/@ff-labs/pi-fff)'s `ffgrep`/`fffind` are present to take over searching. Without pi-fff, nothing else is touched.
- Removal re-runs on every session/agent start, so it also covers renderer extensions (e.g. pi-claude-style-tools) that re-register the default-hidden built-ins as a side effect.

## Comparison

| | pi-pwsh-notify | @4fu/pi-pwsh | pi-powershell | @marcfargas/pi-powershell |
| --- | --- | --- | --- | --- |
| Foreground PowerShell | ✅ | ✅ | translation layer over bash | ✅ (adds tool) |
| Background jobs | ✅ | via `Start-Job` | user commands only | ✅ |
| **Agent auto-notified on completion** | ✅ | ❌ (agent must poll) | ❌ | ❌ (agent must poll) |
| **Ready notification for never-exiting servers** (`notify_on`) | ✅ | ❌ | ❌ | ❌ |
| **Mid-turn delivery + batching** (steered before the next LLM call; co-finishers merged into one message) | ✅ | ❌ | ❌ | ❌ |
| **Blocking wait on pattern/exit** (Claude Code's Monitor) | ✅ | ❌ | ❌ | ❌ |
| `cd` persists between calls | ✅ | ❌ | ❌ | ❌ |

## Requirements

- Windows. PowerShell 7 (`pwsh`) recommended — install with `winget install Microsoft.PowerShell`. Falls back to Windows PowerShell 5.1 if pwsh is not found.

## Notes

- Each `pwsh` call is a fresh process: variables and functions do not persist between calls. `cd` *does* persist — the extension tracks the final working directory of every call.
- Provided as-is; issues and PRs welcome but response times are not guaranteed.

---

## 中文说明

Windows 下给 [pi](https://pi.dev) 用的 PowerShell 7 shell，带 Claude Code 风格的后台任务：**任务结束后自动通知 agent，无需轮询**。

```
pi install npm:pi-pwsh-notify
```

### 它解决的问题

在 Windows 上用 pi 时遇到过以下任何一条，装它就对了：

- pi 内置的 `bash` 工具走 Git Bash（MSYS），agent 一运行 `npm run dev` 等常驻/后台进程，**整个会话就卡死挂起**，再也不回来
- 工具输出里的**中文乱码**（`???`、`锟斤拷`），Windows 路径被 MSYS 路径转换弄坏
- 已有的 PowerShell 扩展虽然能开后台任务，但要 agent **反复轮询状态**，白白烧 token

### 工作方式

agent 在后台启动构建或 dev server 后可以继续和你对话；进程退出时，一条带退出码和输出尾部的 `<background-job-finished>` 通知会**自动注入会话，agent 立即醒来处理**——体验和 Claude Code 的后台任务一致。对 dev server 这类**永不退出**的进程，传一个 `notify_on` 正则（如 `"Local:.*http"`），输出首次匹配时注入一条 `<background-job-ready>` 就绪通知——"服务起来了"同样零轮询。

通知的投递方式也复刻了 Claude Code，底层用的是 pi 官方的 steering 通道（`deliverAs: "steer"`）：**agent 正在工作时**，通知在它**下一次 LLM 调用前**注入——模型几秒内就知道"服务起来了/任务失败了"，而不是等回合结束（`followUp` 的行为）才收到一条它早已自己发现并处理过的过期消息；**agent 空闲时**由 `triggerTurn` 立即唤醒。事件先经 250ms 去抖**合并成一条消息**再发——pi 的 steering 队列每次 LLM 调用只投一条，不合并的话 N 个同时结束的任务就要多花 N 次调用。正在被 `pwsh_job wait` 阻塞等待的任务退出时，结果由 wait 的返回值直接带回，多余的结束通知会被抑制。TUI 里通知渲染成一行紧凑的状态行（`● bg job bg-1 (pytest) · exited 0 · 7s`），不会刷屏。有后台任务存活时，pi 状态栏还会显示 `1 bg job running`（对应 Claude Code 的 "1 shell running"），最后一个任务退出后自动消失。

### 工具

只有两个工具，形状和 Claude Code 一致——后台执行是参数，不是单独的工具。

| 工具 | 用途 |
| --- | --- |
| `pwsh` | 执行命令（替换内置 `bash`）；`run_in_background: true` 启动后台任务并**在退出时自动通知**，`notify_on` 正则为常驻进程加**就绪通知** |
| `pwsh_job` | 后台任务管理：增量输出 / **阻塞等待**（对应 Claude Code 的 Monitor：等输出匹配正则或进程退出）/ 列表 / 杀掉整棵进程树 |

前台 `pwsh`：**`cd` 在调用之间持久**（变量/函数不持久，每次都是全新 `pwsh -NoProfile -NonInteractive` 进程）；命令经 `-EncodedCommand` 传递，**嵌套引号永不出错**；强制 UTF-8（含 Python 子进程）；默认 120 秒超时并清理整棵进程树；结尾 `&` 会被拦截并提示改用后台参数（PowerShell job 会随宿主进程静默死亡）。`pwsh_job` 的输出是**增量的**——每次只返回上次检查之后的新输出，反复查看不重复烧 token；确实需要等结果才能继续时用 `wait`（pattern + timeout）阻塞等待，彻底取代轮询。

有任务在跑时，输入框下方会出现一个**可进入的任务列表**（Claude Code 风格）：空提示符按 `→`（或 `Tab`）进入，`↑`/`↓` 选择任务，`Enter` 打开**实时输出面板**——可滚动、自动跟随新输出（`PgUp`/`PgDn`/`Home`/`End`），在面板里连按两次 `x` 直接**杀掉任务**。（`↓`/`←` 故意留给 pi-subagents 的 fleet 列表，两个列表可以同时显示、各自进入。）任务属于当前会话：会话结束时（pi 退出——包括**直接关掉终端窗口**，SIGHUP/SIGBREAK/SIGTERM 都已处理；或 `/reload`、`/new`、`/resume`、`/fork` 切换会话）残留任务会被统一回收，不留孤儿 dev server 占着端口。

### 要求

Windows。建议 PowerShell 7（`winget install Microsoft.PowerShell`），未安装则回退到 Windows PowerShell 5.1。

## License

MIT
