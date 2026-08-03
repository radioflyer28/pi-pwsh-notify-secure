/**
 * pi-pwsh-notify: PowerShell 7 shell for pi on Windows, with Claude Code-style
 * background jobs that auto-notify the agent on completion.
 *
 * Foreground: a `pwsh` tool replaces the built-in bash tool (bash is removed
 * from the active tool list; grep/find are removed only when pi-fff's
 * ffgrep/fffind are present to take over searching).
 *
 * Background: `pwsh_bg` starts a job and returns immediately; when the process
 * exits, a <background-job-finished> notification is injected into the
 * conversation via pi.sendMessage, waking the agent — no polling.
 * `pwsh_bg_output` / `pwsh_bg_list` / `pwsh_bg_kill` manage running jobs.
 *
 * The notification is a *custom* message, not a fake user message: the LLM
 * still sees the full tagged text, but the TUI renders it as a compact,
 * tool-result-like status line (expand to see the output tail) instead of a
 * wall of text inside a `User` box.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

const FG_DEFAULT_TIMEOUT_SEC = 120;
const FG_MAX_RESULT_CHARS = 50_000;
const FG_LIVE_PREVIEW_CHARS = 4_000;
const BG_MAX_BUFFER_CHARS = 400_000;
const BG_NOTIFY_TAIL_LINES = 60;
/** customType used for the job-finished message + its TUI renderer. */
const NOTIFY_TYPE = "pwsh-bg-notify";
/** Output lines shown in the collapsed (default) notification row. */
const NOTIFY_COLLAPSED_LINES = 3;
// BOM-less UTF-8: [System.Text.Encoding]::UTF8 emits a BOM, which corrupts the
// first chunk piped into native stdin (e.g. `Get-Content key | ssh "cat >> file"`).
const UTF8_PRELUDE =
	"$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Continue'; ";
// pwsh -Command flattens native exit codes unless re-raised explicitly.
const EXIT_CODE_SUFFIX = "\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }";

const SPAWN_ENV = {
	PYTHONIOENCODING: "utf-8",
	PYTHONUTF8: "1",
	PYTHONUNBUFFERED: "1",
	NO_COLOR: "1",
	FORCE_COLOR: "0",
};

interface BgJob {
	id: string;
	name?: string;
	command: string;
	cwd: string;
	proc: ChildProcess;
	output: string;
	truncated: boolean;
	startedAt: number;
	endedAt?: number;
	exitCode: number | null;
	running: boolean;
	killedByTool: boolean;
	timedOut: boolean;
	timer?: NodeJS.Timeout;
}

function findShell(): string {
	for (const exe of ["pwsh.exe", "powershell.exe"]) {
		const r = spawnSync("where.exe", [exe], { windowsHide: true });
		if (r.status === 0) return exe;
	}
	throw new Error("Neither pwsh.exe nor powershell.exe found on PATH");
}

function killTree(pid: number): void {
	spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
}

function shellArgs(command: string): string[] {
	return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command];
}

function fmtDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m${s % 60}s`;
}

function tailLines(text: string, n: number): string {
	const lines = text.split("\n");
	return lines.length <= n ? text : lines.slice(-n).join("\n");
}

function tailChars(text: string, n: number): string {
	return text.length <= n ? text : text.slice(text.length - n);
}

function statusOf(job: BgJob): string {
	if (job.running) return "running";
	if (job.timedOut) return "timeout (killed)";
	if (job.killedByTool) return "killed";
	return `exited ${job.exitCode}`;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function ellipsize(text: string, n: number): string {
	return text.length <= n ? text : `${text.slice(0, n - 1)}…`;
}

/** Structured payload for the notification renderer. */
interface NotifyDetails {
	id: string;
	name?: string;
	status: string;
	ok: boolean;
	duration: string;
	command: string;
	output: string;
}

export default function pwshNotifyExtension(pi: ExtensionAPI) {
	let shell: string | undefined;
	const jobs = new Map<string, BgJob>();
	let jobCounter = 0;

	// ------------------------------------------------------------------
	// Compact TUI rendering for job-finished notifications. Without this the
	// message would be dumped verbatim into a `User`-looking block, which is
	// visually indistinguishable from something the human typed.
	// ------------------------------------------------------------------
	pi.registerMessageRenderer<NotifyDetails>(NOTIFY_TYPE, (message, { expanded }, theme) => {
		const d = message.details;
		if (!d) return undefined; // fall back to default rendering

		const tone = d.ok ? "success" : "error";
		const label = d.name ? `${d.id} (${d.name})` : d.id;
		const lines: string[] = [
			[
				theme.fg(tone, "●"),
				theme.fg("toolTitle", "bg job"),
				theme.fg("accent", label),
				theme.fg("dim", "·"),
				theme.fg(tone, d.status),
				theme.fg("dim", `· ${d.duration}`),
			].join(" "),
			theme.fg("dim", `  ${ellipsize(d.command, 110)}`),
		];

		const out = d.output.trim();
		if (out) {
			const all = out.split("\n");
			const shown = expanded ? all : all.slice(-NOTIFY_COLLAPSED_LINES);
			if (!expanded && all.length > shown.length) {
				lines.push(theme.fg("dim", `  … ${all.length - shown.length} earlier lines`));
			}
			for (const line of shown) {
				lines.push(theme.fg("toolOutput", `  ${expanded ? line : ellipsize(line, 160)}`));
			}
		}

		return new Text(lines.join("\n"), 0, 0);
	});

	// ------------------------------------------------------------------
	// Deactivate built-ins superseded by this extension. Some renderer
	// extensions (e.g. pi-claude-style-tools) re-register the default-hidden
	// built-ins to attach custom renderers, which re-activates them as a side
	// effect — so pruning must run on every session/agent start, not just once.
	// bash is always removed (pwsh replaces it); grep/find only when pi-fff's
	// indexed search tools are present to take over.
	// ------------------------------------------------------------------
	const prune = () => {
		const active = pi.getActiveTools();
		const hide = new Set(["bash"]);
		if (active.includes("ffgrep") || active.includes("fffind")) {
			hide.add("grep");
			hide.add("find");
		}
		if (active.some((t) => hide.has(t))) {
			pi.setActiveTools(active.filter((t) => !hide.has(t)));
		}
	};
	pi.on("session_start", prune);
	pi.on("agent_start", prune);

	// Reap surviving background jobs when pi exits, so no invisible orphan
	// dev servers are left behind.
	process.on("exit", () => {
		for (const job of jobs.values()) {
			if (job.running && job.proc.pid) {
				try {
					killTree(job.proc.pid);
				} catch {}
			}
		}
	});

	// ------------------------------------------------------------------
	// Foreground pwsh tool (replaces built-in bash)
	// ------------------------------------------------------------------
	pi.registerTool({
		name: "pwsh",
		label: "pwsh",
		description:
			`Execute a command in PowerShell 7 on Windows and return its combined stdout/stderr. Each call is a fresh non-interactive process started in the project directory — cd, variables, and functions do NOT persist between calls; chain dependent steps in one command. Default timeout ${FG_DEFAULT_TIMEOUT_SEC}s (override with timeout param). Long-running or never-ending commands (dev servers, watchers, big builds) must use pwsh_bg instead.`,
		promptSnippet: "Run PowerShell 7 command (the shell on this Windows machine)",
		promptGuidelines: [
			"The shell is PowerShell 7, not bash: use PowerShell syntax ($env:VAR, cmdlets, PowerShell quoting). && and || work. Windows and forward-slash paths both accepted.",
			"Never run interactive commands (Read-Host, pause, git rebase -i): the process is non-interactive and they will hang until timeout.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "PowerShell command line to run" }),
			timeout: Type.Optional(
				Type.Number({
					description: `Timeout in seconds (default ${FG_DEFAULT_TIMEOUT_SEC}). The process tree is killed on timeout.`,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			shell ??= findShell();
			const timeoutSec = params.timeout ?? FG_DEFAULT_TIMEOUT_SEC;
			return await new Promise((resolve, reject) => {
				const proc = spawn(shell!, shellArgs(UTF8_PRELUDE + params.command + EXIT_CODE_SUFFIX), {
					cwd: ctx.cwd,
					windowsHide: true,
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, ...SPAWN_ENV },
				});
				let out = "";
				let timedOut = false;
				let aborted = false;
				const timer =
					timeoutSec > 0
						? setTimeout(() => {
								timedOut = true;
								if (proc.pid) killTree(proc.pid);
							}, timeoutSec * 1000)
						: undefined;
				const onAbort = () => {
					aborted = true;
					if (proc.pid) killTree(proc.pid);
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				const append = (chunk: Buffer) => {
					out += chunk.toString("utf8");
					onUpdate?.(textResult(tailChars(out, FG_LIVE_PREVIEW_CHARS)));
				};
				proc.stdout?.on("data", append);
				proc.stderr?.on("data", append);
				const cleanup = () => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
				};
				proc.on("error", (err) => {
					cleanup();
					reject(err);
				});
				proc.on("close", (code) => {
					cleanup();
					let text = out.trim();
					if (text.length > FG_MAX_RESULT_CHARS) {
						text = `[output truncated, showing tail]\n${tailChars(text, FG_MAX_RESULT_CHARS)}`;
					}
					const notes: string[] = [];
					if (timedOut) notes.push(`command timed out after ${timeoutSec}s and was killed`);
					else if (aborted) notes.push("command aborted");
					else if (code !== 0) notes.push(`exit code: ${code}`);
					if (notes.length > 0) text = text ? `${text}\n\n${notes.join("; ")}` : notes.join("; ");
					resolve(textResult(text || "(no output)"));
				});
			});
		},
	});

	// ------------------------------------------------------------------
	// Background jobs: pwsh_bg + output / list / kill, auto-notify on exit
	// ------------------------------------------------------------------
	function notify(job: BgJob): void {
		const dur = fmtDuration((job.endedAt ?? Date.now()) - job.startedAt);
		const label = job.name ? `${job.id} (${job.name})` : job.id;
		const out = tailLines(job.output, BG_NOTIFY_TAIL_LINES).trim();
		const status = statusOf(job);
		const content = [
			`<background-job-finished id="${job.id}">`,
			`Job ${label} — status: ${status}, runtime ${dur}`,
			`Command: ${job.command}`,
			`--- output tail (last ${BG_NOTIFY_TAIL_LINES} lines) ---`,
			out || "(no output)",
			`</background-job-finished>`,
			"This is an automated notification, not the user typing. If the result affects current or planned work, act on it; otherwise report it to the user in one short sentence.",
		].join("\n");
		const details: NotifyDetails = {
			id: job.id,
			name: job.name,
			status,
			ok: !job.timedOut && !job.killedByTool && job.exitCode === 0,
			duration: dur,
			command: job.command,
			output: out,
		};
		try {
			// A custom message keeps the LLM payload identical to before while
			// letting the TUI show a one-line status row. triggerTurn wakes an
			// idle agent the same way sendUserMessage used to.
			pi.sendMessage<NotifyDetails>(
				{ customType: NOTIFY_TYPE, content, display: true, details },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			// The session may already be gone in print/RPC mode; a failed
			// notification must not affect the job itself.
		}
	}

	pi.registerTool({
		name: "pwsh_bg",
		label: "pwsh_bg",
		description:
			"Run a command in a background PowerShell 7 process. Returns immediately with a job id. When the process exits, a <background-job-finished> notification with exit code and output tail is automatically injected into the conversation — no polling needed. Use for anything long-running: builds, test suites, dev servers, downloads.",
		promptSnippet: "Run command in background PowerShell (auto-notifies on completion)",
		promptGuidelines: [
			"Use pwsh_bg instead of pwsh for commands that run longer than ~30s or indefinitely (dev servers, watchers, builds).",
			"After starting a background job, continue with other work or end your turn; completion arrives automatically. Only use pwsh_bg_output when you need intermediate output from a still-running job.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "PowerShell command line to run" }),
			name: Type.Optional(Type.String({ description: "Short human-readable job name" })),
			cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
			timeout_sec: Type.Optional(
				Type.Number({ description: "Kill the job after this many seconds (default: no timeout)" }),
			),
		}),
		executionMode: "parallel",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			shell ??= findShell();
			const id = `bg-${++jobCounter}`;
			const cwd = params.cwd ?? ctx.cwd;
			const proc = spawn(shell, shellArgs(UTF8_PRELUDE + params.command), {
				cwd,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, ...SPAWN_ENV },
			});
			const job: BgJob = {
				id,
				name: params.name,
				command: params.command,
				cwd,
				proc,
				output: "",
				truncated: false,
				startedAt: Date.now(),
				exitCode: null,
				running: true,
				killedByTool: false,
				timedOut: false,
			};
			const append = (chunk: Buffer) => {
				job.output += chunk.toString("utf8");
				if (job.output.length > BG_MAX_BUFFER_CHARS) {
					job.output = job.output.slice(job.output.length - BG_MAX_BUFFER_CHARS);
					job.truncated = true;
				}
			};
			proc.stdout?.on("data", append);
			proc.stderr?.on("data", append);
			if (params.timeout_sec && params.timeout_sec > 0) {
				job.timer = setTimeout(() => {
					if (job.running && proc.pid) {
						job.timedOut = true;
						killTree(proc.pid);
					}
				}, params.timeout_sec * 1000);
				job.timer.unref?.();
			}
			proc.on("error", (err) => {
				if (!job.running) return;
				job.running = false;
				job.endedAt = Date.now();
				job.output += `\n[spawn error] ${err.message}`;
				if (job.timer) clearTimeout(job.timer);
				notify(job);
			});
			proc.on("close", (code) => {
				if (!job.running) return;
				job.running = false;
				job.endedAt = Date.now();
				job.exitCode = code;
				if (job.timer) clearTimeout(job.timer);
				if (!job.killedByTool) notify(job);
			});
			jobs.set(id, job);
			return textResult(
				`Started background job ${id}${params.name ? ` (${params.name})` : ""}, PID ${proc.pid}. You will be notified automatically when it finishes.`,
			);
		},
	});

	pi.registerTool({
		name: "pwsh_bg_output",
		label: "pwsh_bg_output",
		description: "Read the output captured so far from a background job started with pwsh_bg.",
		promptSnippet: "Read background job output",
		parameters: Type.Object({
			id: Type.String({ description: "Job id, e.g. bg-1" }),
			lines: Type.Optional(
				Type.Number({ description: "Tail lines to return (default 100, 0 = full captured buffer)" }),
			),
		}),
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			const job = jobs.get(params.id);
			if (!job) {
				throw new Error(`No such job: ${params.id}. Known jobs: ${[...jobs.keys()].join(", ") || "none"}`);
			}
			const n = params.lines ?? 100;
			const body = n === 0 ? job.output : tailLines(job.output, n);
			const dur = fmtDuration((job.endedAt ?? Date.now()) - job.startedAt);
			const head = `${job.id} — ${statusOf(job)}, ${job.running ? "running for" : "ran"} ${dur}${
				job.truncated ? " (buffer truncated, oldest output dropped)" : ""
			}`;
			return textResult(`${head}\n${body.trim() || "(no output yet)"}`);
		},
	});

	pi.registerTool({
		name: "pwsh_bg_list",
		label: "pwsh_bg_list",
		description: "List all background jobs started this session with their status.",
		promptSnippet: "List background jobs",
		parameters: Type.Object({}),
		executionMode: "parallel",
		async execute() {
			if (jobs.size === 0) return textResult("No background jobs this session.");
			const rows = [...jobs.values()].map((j) => {
				const cmd = j.command.length > 80 ? `${j.command.slice(0, 80)}…` : j.command;
				return `${j.id}${j.name ? ` (${j.name})` : ""} — ${statusOf(j)} — ${cmd}`;
			});
			return textResult(rows.join("\n"));
		},
	});

	pi.registerTool({
		name: "pwsh_bg_kill",
		label: "pwsh_bg_kill",
		description:
			"Kill a running background job and its child processes. No completion notification is sent for jobs you kill.",
		promptSnippet: "Kill a background job",
		parameters: Type.Object({
			id: Type.String({ description: "Job id, e.g. bg-1" }),
		}),
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			const job = jobs.get(params.id);
			if (!job) {
				throw new Error(`No such job: ${params.id}. Known jobs: ${[...jobs.keys()].join(", ") || "none"}`);
			}
			if (!job.running) return textResult(`${job.id} already finished (${statusOf(job)}).`);
			job.killedByTool = true;
			if (job.proc.pid) killTree(job.proc.pid);
			return textResult(`Killed ${job.id} (PID ${job.proc.pid}).`);
		},
	});
}
