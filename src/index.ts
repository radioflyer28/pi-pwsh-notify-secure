/**
 * pi-pwsh-notify: PowerShell 7 shell for pi on Windows, with Claude Code-style
 * background jobs that auto-notify the agent — no polling.
 *
 * Two tools:
 *  - `pwsh`     foreground execution (replaces built-in bash; cd persists between
 *               calls), or `run_in_background: true` for jobs that inject a
 *               <background-job-finished> notification on exit. A `notify_on`
 *               regex additionally injects a <background-job-ready> notification
 *               on first output match — covers dev servers that never exit.
 *  - `pwsh_job` output (incremental since last check) / wait (block until output
 *               matches a pattern or the job exits) / list / kill.
 *
 * Notification delivery mirrors Claude Code, built on pi's official steering
 * channel: events are debounced into ONE custom message and sent with
 * deliverAs "steer" — pi injects it before the agent's next LLM call while it
 * is working (the model learns within seconds, mid-turn, never stale), and
 * triggerTurn wakes an idle agent. The debounce matters because pi's steering
 * queue drains one message per LLM call: without merging, N jobs finishing
 * together would cost N calls.
 *
 * Notifications are *custom* messages/entries, not fake user messages: the LLM
 * sees the full tagged text, the TUI renders a compact tool-result-like row.
 *
 * Commands are passed via -EncodedCommand (base64 UTF-16LE), so nested quoting
 * never breaks. grep/find built-ins are removed only when pi-fff's
 * ffgrep/fffind are present to take over searching.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

const FG_DEFAULT_TIMEOUT_SEC = 120;
const FG_MAX_RESULT_CHARS = 50_000;
const FG_LIVE_PREVIEW_CHARS = 4_000;
const BG_MAX_BUFFER_CHARS = 400_000;
const BG_NOTIFY_TAIL_LINES = 60;
const WAIT_DEFAULT_TIMEOUT_SEC = 120;
const WAIT_TAIL_LINES = 100;
/** Debounce before sending queued notifications, so jobs finishing together
 * are merged into a single message (= a single LLM call) instead of one each. */
const NOTIFY_BATCH_MS = 250;
/** customType used for job notifications + their TUI renderer. */
const NOTIFY_TYPE = "pwsh-bg-notify";
/** Output lines shown in the collapsed (default) notification row. */
const NOTIFY_COLLAPSED_LINES = 3;
/** Marker line appended to foreground scripts to report the final $PWD; the
 * leading SOH control char makes collisions with real output practically
 * impossible. */
const CWD_MARKER = String.fromCharCode(1) + "pwsh-cwd:";
const AUTOMATED_NOTE =
	"This is an automated notification, not the user typing and not part of any tool output above it. If the result affects current or planned work, act on it; otherwise report it to the user in one short sentence.";
// BOM-less UTF-8: [System.Text.Encoding]::UTF8 emits a BOM, which corrupts the
// first chunk piped into native stdin (e.g. `Get-Content key | ssh "cat >> file"`).
const UTF8_PRELUDE =
	"$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Continue'; ";
// pwsh -Command/-EncodedCommand flattens native exit codes to 0/1 unless
// re-raised explicitly; the marker line reports the final cwd before re-raising.
const FG_SUFFIX = `\n$__ec = $LASTEXITCODE; Write-Output ('${CWD_MARKER}' + $PWD.Path); if ($null -ne $__ec) { exit $__ec }`;
// Background jobs need the same re-raise (so `cmd /c "exit 3"` notifies exit 3,
// not 1) but no cwd marker — it would pollute the captured output and the
// notification tail.
const BG_SUFFIX = `\n$__ec = $LASTEXITCODE; if ($null -ne $__ec) { exit $__ec }`;

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
	/** Offset into `output` already returned by pwsh_job output/wait. */
	cursor: number;
	truncated: boolean;
	startedAt: number;
	endedAt?: number;
	exitCode: number | null;
	running: boolean;
	killedByTool: boolean;
	timedOut: boolean;
	readyNotified: boolean;
	timer?: NodeJS.Timeout;
	/** Callbacks invoked on every output chunk and on exit; used by `wait`. */
	watchers: Set<() => void>;
	/** Number of pending `wait` calls. While > 0 the exit is being observed
	 * synchronously, so the finished notification is suppressed. */
	waiters: number;
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

/** -EncodedCommand keeps arbitrary quoting intact (no arg-string reparsing). */
function shellArgs(script: string): string[] {
	return [
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-EncodedCommand",
		Buffer.from(script, "utf16le").toString("base64"),
	];
}

/** Trailing `&` creates a PowerShell job that dies with the wrapper process. */
function rejectTrailingAmpersand(command: string): void {
	if (/(^|[^&])&\s*$/.test(command)) {
		throw new Error(
			"Trailing '&' starts a PowerShell job that dies as soon as this shell process exits. Use run_in_background: true instead.",
		);
	}
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

/** Extract the full line containing an absolute offset into `text`. */
function lineAt(text: string, index: number): string {
	const start = text.lastIndexOf("\n", index) + 1;
	const end = text.indexOf("\n", index);
	return text.slice(start, end === -1 ? undefined : end).trim();
}

/** Structured payload for one job's notification row. */
interface NotifyDetails {
	id: string;
	name?: string;
	status: string;
	ok: boolean;
	duration: string;
	command: string;
	output: string;
}

/** Renderer payload: one message/entry can carry several batched jobs. */
interface NotifyBatch {
	jobs: NotifyDetails[];
}

/** A queued notification: LLM text block + its TUI row. */
interface PendingNotify {
	content: string;
	details: NotifyDetails;
}

export default function pwshNotifyExtension(pi: ExtensionAPI) {
	let shell: string | undefined;
	/** Persisted working directory: cd survives across pwsh calls. */
	let currentCwd: string | undefined;
	const jobs = new Map<string, BgJob>();
	let jobCounter = 0;

	// ------------------------------------------------------------------
	// Footer status: "1 bg job running" while background jobs are alive,
	// like Claude Code's "1 shell running". Job exits happen outside any
	// event handler, so the most recent ExtensionContext is captured (from
	// session_start and pwsh calls) and reused for setStatus.
	// ------------------------------------------------------------------
	let uiCtx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined;

	function updateRunningStatus(): void {
		if (!uiCtx?.hasUI) return;
		let n = 0;
		for (const j of jobs.values()) if (j.running) n++;
		try {
			uiCtx.ui.setStatus("pwsh-bg", n === 0 ? undefined : `${n} bg job${n === 1 ? "" : "s"} running`);
		} catch {}
	}
	pi.on("session_start", (_event, ctx) => {
		uiCtx = ctx;
		updateRunningStatus();
	});

	// ------------------------------------------------------------------
	// Notification queue. Job events are debounced briefly and merged into a
	// single custom message, then handed to pi's steering channel: while the
	// agent is streaming, deliverAs "steer" injects the message before its
	// next LLM call (mid-turn, Claude Code style — never stale news after the
	// turn); when idle, triggerTurn wakes it. Merging matters because the
	// steering queue drains one message per LLM call.
	// ------------------------------------------------------------------
	const pending: PendingNotify[] = [];
	let flushTimer: NodeJS.Timeout | undefined;

	function flushNotifications(): void {
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		const batch = pending.splice(0, pending.length);
		if (batch.length === 0) return;
		try {
			// A custom message keeps the LLM payload identical while letting the
			// TUI show compact status rows.
			pi.sendMessage<NotifyBatch>(
				{
					customType: NOTIFY_TYPE,
					content: [...batch.map((b) => b.content), AUTOMATED_NOTE].join("\n"),
					display: true,
					details: { jobs: batch.map((b) => b.details) },
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
		} catch {
			// The session may already be gone in print/RPC mode; a failed
			// notification must not affect the job itself.
		}
	}

	function queueNotify(
		job: BgJob,
		tag: string,
		headline: string,
		output: string,
		status: string,
		ok: boolean,
		dur: string,
	): void {
		pending.push({
			content: [`<${tag} id="${job.id}">`, headline, `Command: ${job.command}`, output, `</${tag}>`].join("\n"),
			details: { id: job.id, name: job.name, status, ok, duration: dur, command: job.command, output },
		});
		if (!flushTimer) {
			flushTimer = setTimeout(flushNotifications, NOTIFY_BATCH_MS);
			flushTimer.unref?.();
		}
	}

	// ------------------------------------------------------------------
	// Compact TUI rendering for job notifications. Without this the message
	// would be dumped verbatim into a `User`-looking block, visually
	// indistinguishable from something the human typed.
	// ------------------------------------------------------------------
	type ThemeArg = Parameters<Parameters<typeof pi.registerMessageRenderer>[1]>[2];

	function renderRows(jobs_: NotifyDetails[], expanded: boolean, theme: ThemeArg): Text {
		const lines: string[] = [];
		for (const d of jobs_) {
			const tone = d.ok ? "success" : "error";
			const label = d.name ? `${d.id} (${d.name})` : d.id;
			lines.push(
				[
					theme.fg(tone, "●"),
					theme.fg("toolTitle", "bg job"),
					theme.fg("accent", label),
					theme.fg("dim", "·"),
					theme.fg(tone, d.status),
					theme.fg("dim", `· ${d.duration}`),
				].join(" "),
				theme.fg("dim", `  ${ellipsize(d.command, 110)}`),
			);
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
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	/** Pre-0.4 sessions stored a single NotifyDetails instead of a batch. */
	function asBatch(d: unknown): NotifyDetails[] | undefined {
		if (!d || typeof d !== "object") return undefined;
		if (Array.isArray((d as NotifyBatch).jobs)) return (d as NotifyBatch).jobs;
		if (typeof (d as NotifyDetails).id === "string") return [d as NotifyDetails];
		return undefined;
	}

	pi.registerMessageRenderer<NotifyBatch>(NOTIFY_TYPE, (message, { expanded }, theme) => {
		const jobs_ = asBatch(message.details);
		return jobs_ ? renderRows(jobs_, expanded, theme) : undefined; // fall back to default rendering
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
	// dev servers are left behind. "exit" only fires on graceful shutdown;
	// closing the terminal window delivers SIGHUP (and ctrl+break SIGBREAK),
	// whose default action terminates Node before any exit handler runs —
	// Windows grants a few seconds of grace after console close, enough to
	// kill the process trees explicitly.
	const reap = () => {
		for (const job of jobs.values()) {
			if (job.running && job.proc.pid) {
				try {
					killTree(job.proc.pid);
				} catch {}
			}
		}
	};
	process.on("exit", reap);
	for (const sig of ["SIGHUP", "SIGBREAK", "SIGTERM"] as const) {
		process.on(sig, () => {
			reap();
			process.exit(0);
		});
	}

	function notifyFinished(job: BgJob): void {
		const dur = fmtDuration((job.endedAt ?? Date.now()) - job.startedAt);
		const label = job.name ? `${job.id} (${job.name})` : job.id;
		const out = tailLines(job.output, BG_NOTIFY_TAIL_LINES).trim();
		const status = statusOf(job);
		queueNotify(
			job,
			"background-job-finished",
			`Job ${label} — status: ${status}, runtime ${dur}`,
			`--- output tail (last ${BG_NOTIFY_TAIL_LINES} lines) ---\n${out || "(no output)"}`,
			status,
			!job.timedOut && !job.killedByTool && job.exitCode === 0,
			dur,
		);
	}

	function notifyReady(job: BgJob, matchedLine: string): void {
		const dur = fmtDuration(Date.now() - job.startedAt);
		const label = job.name ? `${job.id} (${job.name})` : job.id;
		queueNotify(
			job,
			"background-job-ready",
			`Job ${label} is ready — output matched notify_on after ${dur}; the process keeps running.`,
			`Matched: ${matchedLine}`,
			"ready",
			true,
			dur,
		);
	}

	// ------------------------------------------------------------------
	// pwsh: foreground execution, or background with run_in_background
	// ------------------------------------------------------------------
	pi.registerTool({
		name: "pwsh",
		label: "pwsh",
		description:
			`Run a command in PowerShell 7 on Windows; returns combined stdout/stderr. cd persists between calls; variables and functions do not (fresh process per call — chain dependent steps in one command). Foreground calls are killed after ${FG_DEFAULT_TIMEOUT_SEC}s by default (timeout param). For anything long-running or never-ending (dev servers, watchers, builds, test suites) set run_in_background: true — returns a job id immediately, and a <background-job-finished> notification with exit code and output tail is delivered automatically when the process exits (attached to your next tool result while you work, or as a new message when you are idle); no polling. For servers that never exit, also pass notify_on (regex): the first output match delivers a <background-job-ready> notification, e.g. notify_on: "Local:.*http" for vite. To block until a job's output matches a pattern, use pwsh_job action "wait".`,
		promptSnippet: "Run PowerShell 7 command (the shell on this Windows machine)",
		promptGuidelines: [
			"The shell is PowerShell 7, not bash: use PowerShell syntax ($env:VAR, cmdlets, PowerShell quoting). && and || work. Windows and forward-slash paths both accepted.",
			"Never run interactive commands (Read-Host, pause, git rebase -i): the process is non-interactive and they will hang until timeout.",
			"After starting a background job, continue with other work or end your turn; ready/finished notifications arrive on their own. If you cannot proceed without the job's result, block on it with pwsh_job action \"wait\" (pattern/exit/timeout) instead of polling pwsh_job output.",
			"Never fabricate or predict a pending background job's result — notifications are injected by the system, never written by you. Report only what a notification, wait, or output check actually said.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "PowerShell command line to run" }),
			run_in_background: Type.Optional(
				Type.Boolean({
					description: "Run as a background job: returns a job id immediately, auto-notifies on exit.",
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					description: `Seconds before the process tree is killed. Default: ${FG_DEFAULT_TIMEOUT_SEC} foreground, unlimited background.`,
				}),
			),
			name: Type.Optional(Type.String({ description: "Short human-readable job name (background only)" })),
			notify_on: Type.Optional(
				Type.String({
					description:
						"Background only: regex tested against job output; the first match injects a one-time <background-job-ready> notification. Use for dev servers/watchers that never exit.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			uiCtx = ctx;
			shell ??= findShell();
			rejectTrailingAmpersand(params.command);
			if (currentCwd && !existsSync(currentCwd)) currentCwd = undefined;
			const cwd = currentCwd ?? ctx.cwd;

			// ---------- background ----------
			if (params.run_in_background) {
				let readyRegex: RegExp | undefined;
				if (params.notify_on) {
					try {
						readyRegex = new RegExp(params.notify_on, "m");
					} catch (err) {
						throw new Error(`Invalid notify_on regex: ${String(err)}`);
					}
				}
				const id = `bg-${++jobCounter}`;
				const proc = spawn(shell, shellArgs(UTF8_PRELUDE + params.command + BG_SUFFIX), {
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
					cursor: 0,
					truncated: false,
					startedAt: Date.now(),
					exitCode: null,
					running: true,
					killedByTool: false,
					timedOut: false,
					readyNotified: false,
					watchers: new Set(),
					waiters: 0,
				};
				const append = (chunk: Buffer) => {
					job.output += chunk.toString("utf8");
					if (job.output.length > BG_MAX_BUFFER_CHARS) {
						const dropped = job.output.length - BG_MAX_BUFFER_CHARS;
						job.output = job.output.slice(dropped);
						job.cursor = Math.max(0, job.cursor - dropped);
						job.truncated = true;
					}
					if (readyRegex && !job.readyNotified) {
						const m = readyRegex.exec(job.output);
						if (m) {
							job.readyNotified = true;
							notifyReady(job, lineAt(job.output, m.index));
						}
					}
					for (const w of [...job.watchers]) w();
				};
				proc.stdout?.on("data", append);
				proc.stderr?.on("data", append);
				if (params.timeout && params.timeout > 0) {
					job.timer = setTimeout(() => {
						if (job.running && proc.pid) {
							job.timedOut = true;
							killTree(proc.pid);
						}
					}, params.timeout * 1000);
					job.timer.unref?.();
				}
				const onExit = (annotate?: () => void) => {
					if (!job.running) return;
					job.running = false;
					job.endedAt = Date.now();
					annotate?.();
					if (job.timer) clearTimeout(job.timer);
					// An in-flight `wait` observes the exit and returns it directly;
					// a finished notification on top would be redundant.
					const observed = job.waiters > 0;
					for (const w of [...job.watchers]) w();
					if (!job.killedByTool && !observed) notifyFinished(job);
					updateRunningStatus();
				};
				proc.on("error", (err) =>
					onExit(() => {
						job.output += `\n[spawn error] ${err.message}`;
					}),
				);
				proc.on("close", (code) =>
					onExit(() => {
						job.exitCode = code;
					}),
				);
				jobs.set(id, job);
				updateRunningStatus();
				return textResult(
					`Started background job ${id}${params.name ? ` (${params.name})` : ""}, PID ${proc.pid}. You will be notified automatically${
						readyRegex ? " when the output matches notify_on and" : ""
					} when it finishes.`,
				);
			}

			// ---------- foreground ----------
			const timeoutSec = params.timeout ?? FG_DEFAULT_TIMEOUT_SEC;
			return await new Promise((resolve, reject) => {
				const proc = spawn(shell!, shellArgs(UTF8_PRELUDE + params.command + FG_SUFFIX), {
					cwd,
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
					const notes: string[] = [];
					// Extract the cwd marker line (absent if the command exited early).
					let text = out;
					const mi = text.lastIndexOf(CWD_MARKER);
					if (mi >= 0) {
						const le = text.indexOf("\n", mi);
						const dir = text.slice(mi + CWD_MARKER.length, le === -1 ? undefined : le).trim();
						text = text.slice(0, mi) + (le === -1 ? "" : text.slice(le + 1));
						if (dir && dir !== cwd) notes.push(`cwd is now ${dir}`);
						if (dir) currentCwd = dir;
					}
					text = text.trim();
					if (text.length > FG_MAX_RESULT_CHARS) {
						text = `[output truncated, showing tail]\n${tailChars(text, FG_MAX_RESULT_CHARS)}`;
					}
					if (timedOut)
						notes.push(
							`command timed out after ${timeoutSec}s and was killed. If this is a dev server or watcher, rerun with run_in_background: true`,
						);
					else if (aborted) notes.push("command aborted");
					else if (code !== 0) notes.push(`exit code: ${code}`);
					if (notes.length > 0) text = text ? `${text}\n\n${notes.join("; ")}` : notes.join("; ");
					resolve(textResult(text || "(no output)"));
				});
			});
		},
	});

	// ------------------------------------------------------------------
	// pwsh_job: output (incremental) / wait (blocking) / list / kill
	// ------------------------------------------------------------------
	pi.registerTool({
		name: "pwsh_job",
		label: "pwsh_job",
		description:
			'Manage background jobs started with pwsh run_in_background. action "output": return output produced since the previous check (lines caps it; lines=0 returns the full captured buffer). action "wait": block until the job\'s unseen output matches pattern (regex), or the job exits, or timeout seconds pass (default ' +
			WAIT_DEFAULT_TIMEOUT_SEC +
			') — use when you cannot proceed without the result, instead of polling output. action "list": all jobs with status. action "kill": kill the job and its process tree — no completion notification for jobs you kill.',
		promptSnippet: "Background job output / wait / list / kill",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("output"),
				Type.Literal("wait"),
				Type.Literal("list"),
				Type.Literal("kill"),
			]),
			id: Type.Optional(Type.String({ description: "Job id, e.g. bg-1 (required for output, wait and kill)" })),
			lines: Type.Optional(
				Type.Number({ description: "output only: max tail lines to return (default 100, 0 = full buffer)" }),
			),
			pattern: Type.Optional(
				Type.String({
					description:
						"wait only: regex tested against output not yet returned to you; returns on first match. Omit to wait for the job to exit.",
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					description: `wait only: seconds before the wait gives up and returns (job keeps running). Default ${WAIT_DEFAULT_TIMEOUT_SEC}.`,
				}),
			),
		}),
		executionMode: "parallel",
		async execute(_toolCallId, params, signal) {
			if (params.action === "list") {
				if (jobs.size === 0) return textResult("No background jobs this session.");
				const rows = [...jobs.values()].map((j) => {
					const cmd = j.command.length > 80 ? `${j.command.slice(0, 80)}…` : j.command;
					return `${j.id}${j.name ? ` (${j.name})` : ""} — ${statusOf(j)} — ${cmd}`;
				});
				return textResult(rows.join("\n"));
			}
			const job = params.id ? jobs.get(params.id) : undefined;
			if (!job) {
				throw new Error(
					`No such job: ${params.id ?? "(id missing)"}. Known jobs: ${[...jobs.keys()].join(", ") || "none"}`,
				);
			}
			if (params.action === "kill") {
				if (!job.running) return textResult(`${job.id} already finished (${statusOf(job)}).`);
				job.killedByTool = true;
				if (job.proc.pid) killTree(job.proc.pid);
				return textResult(`Killed ${job.id} (PID ${job.proc.pid}).`);
			}
			if (params.action === "wait") {
				let regex: RegExp | undefined;
				if (params.pattern) {
					try {
						regex = new RegExp(params.pattern, "m");
					} catch (err) {
						throw new Error(`Invalid pattern regex: ${String(err)}`);
					}
				}
				const timeoutSec = params.timeout ?? WAIT_DEFAULT_TIMEOUT_SEC;
				// Only output the model hasn't seen counts as a match, so a line
				// already returned by a previous output/wait can't satisfy a new wait.
				const startCursor = job.cursor;
				let matchedLine: string | undefined;
				const outcome = await new Promise<"matched" | "exited" | "timeout" | "aborted">((resolve) => {
					let done = false;
					let timer: NodeJS.Timeout | undefined;
					const finish = (r: "matched" | "exited" | "timeout" | "aborted") => {
						if (done) return;
						done = true;
						job.watchers.delete(check);
						job.waiters--;
						if (timer) clearTimeout(timer);
						signal?.removeEventListener("abort", onAbort);
						resolve(r);
					};
					const check = () => {
						if (regex) {
							const m = regex.exec(job.output.slice(startCursor));
							if (m) {
								matchedLine = lineAt(job.output, startCursor + m.index);
								return finish("matched");
							}
						}
						if (!job.running) finish("exited");
					};
					const onAbort = () => finish("aborted");
					job.watchers.add(check);
					job.waiters++;
					if (timeoutSec > 0) {
						timer = setTimeout(() => finish("timeout"), timeoutSec * 1000);
						timer.unref?.();
					}
					signal?.addEventListener("abort", onAbort, { once: true });
					check(); // the condition may already hold (buffered match / already exited)
				});
				const fresh = job.output.slice(job.cursor);
				job.cursor = job.output.length;
				const dur = fmtDuration((job.endedAt ?? Date.now()) - job.startedAt);
				const head =
					outcome === "matched"
						? `${job.id} — pattern matched, job still ${statusOf(job)} (runtime ${dur})\nMatched: ${matchedLine}`
						: outcome === "exited"
							? `${job.id} — ${statusOf(job)}, ran ${dur}`
							: outcome === "timeout"
								? `${job.id} — wait timed out after ${timeoutSec}s, job still ${statusOf(job)} (runtime ${dur})`
								: `${job.id} — wait aborted, job still ${statusOf(job)}`;
				const body = tailLines(fresh, WAIT_TAIL_LINES).trim();
				return textResult(`${head}\n--- output since last check ---\n${body || "(no output)"}`);
			}
			// action === "output": incremental since the previous check
			const n = params.lines ?? 100;
			const fresh = job.output.slice(job.cursor);
			job.cursor = job.output.length;
			const body = n === 0 ? job.output : tailLines(fresh, n);
			const dur = fmtDuration((job.endedAt ?? Date.now()) - job.startedAt);
			const head = `${job.id} — ${statusOf(job)}, ${job.running ? "running for" : "ran"} ${dur}${
				job.truncated ? " (buffer truncated, oldest output dropped)" : ""
			}${n === 0 ? "" : fresh ? ", new output since last check:" : ""}`;
			return textResult(`${head}\n${body.trim() || (n === 0 ? "(no output)" : "(no new output since last check)")}`);
		},
	});
}
