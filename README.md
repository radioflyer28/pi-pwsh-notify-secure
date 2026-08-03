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

This extension fixes both. The agent starts a build or dev server in the background, keeps chatting with you, and **when the process exits, a notification with the exit code and output tail is automatically injected into the conversation** — the agent wakes up and reacts, exactly like background tasks in Claude Code. Implemented with `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` on process exit: it never interrupts a streaming response, and triggers a new turn when the agent is idle. Because it is a *custom* message rather than a fake user message, the TUI shows a compact one-line status row instead of a wall of text in a `User` box — while the LLM still receives the full tagged notification.

## Tools

| Tool | Purpose |
| --- | --- |
| `pwsh` | Foreground command execution (replaces built-in `bash`) |
| `pwsh_bg` | Start a background job; **auto-notifies on completion** |
| `pwsh_bg_output` | Peek at a running job's captured output |
| `pwsh_bg_list` | List jobs and their status |
| `pwsh_bg_kill` | Kill a job and its child processes (`taskkill /T /F`) |

### Foreground `pwsh`

- Fresh `pwsh -NoProfile -NonInteractive` process per call, started in the project directory
- UTF-8 forced on both PowerShell and Python child processes — non-ASCII output renders correctly
- Default 120s timeout (overridable per call); the whole process **tree** is killed on timeout or abort
- Native exit codes survive the `pwsh -Command` flattening (`exit $LASTEXITCODE` re-raise)
- Live output streaming while the command runs

### Background `pwsh_bg`

- Returns immediately with a job id; output captured in memory (last 400 KB)
- On exit, a `<background-job-finished>` notification (status, runtime, last 60 output lines) is injected into the session
- Rendered in the TUI as a single tool-result-like row — `● bg job bg-1 (pytest) · exited 0 · 7s` plus the last few output lines; expand the message to see the full tail
- Optional `timeout_sec` to kill runaway jobs; jobs killed via `pwsh_bg_kill` do not notify
- Surviving jobs are reaped when pi exits — no invisible orphan dev servers

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

## Requirements

- Windows. PowerShell 7 (`pwsh`) recommended — install with `winget install Microsoft.PowerShell`. Falls back to Windows PowerShell 5.1 if pwsh is not found.

## Notes

- Each `pwsh` call is a fresh process: `cd`, variables, and functions do not persist between calls (by design — keeps `/fork` and session replay sane).
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

agent 在后台启动构建或 dev server 后可以继续和你对话；进程退出时，一条带退出码和输出尾部的 `<background-job-finished>` 通知会**自动注入会话，agent 立即醒来处理**——体验和 Claude Code 的后台任务一致。通知从不打断正在流式输出的回复，agent 空闲时才触发新回合；TUI 里渲染成一行紧凑的状态行（`● bg job bg-1 (pytest) · exited 0 · 7s`），不会刷屏。

### 工具

| 工具 | 用途 |
| --- | --- |
| `pwsh` | 前台执行（替换内置 `bash`） |
| `pwsh_bg` | 启动后台任务，**完成时自动通知** |
| `pwsh_bg_output` | 查看运行中任务的输出 |
| `pwsh_bg_list` | 列出任务及状态 |
| `pwsh_bg_kill` | 杀掉任务及其子进程树 |

前台 `pwsh` 每次调用都是全新的 `pwsh -NoProfile -NonInteractive` 进程，强制 UTF-8（含 Python 子进程），默认 120 秒超时，超时/中止时清理整棵进程树；pi 退出时残留的后台任务会被统一回收，不留孤儿 dev server。

### 要求

Windows。建议 PowerShell 7（`winget install Microsoft.PowerShell`），未安装则回退到 Windows PowerShell 5.1。

## License

MIT
