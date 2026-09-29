import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { buildPowerShellScript, killProcessTree, spawnPowerShell } from "./runtime.js";

export const MAX_TIMEOUT_MS = 2_147_483_647;
export const OUTPUT_MAX_CHARS = 400_000;
export const UPDATE_INTERVAL_MS = 100;
export const EXIT_IDLE_MS = 250;

/** All public shell/wait timeouts, including BashOperations, are seconds. Zero is unlimited. */
export function timeoutMilliseconds(value: number | undefined, fallback = 0): number | undefined {
	const seconds = value ?? fallback;
	if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_TIMEOUT_MS / 1000) {
		throw new Error(`Invalid timeout: expected finite seconds from 0 (unlimited) to ${MAX_TIMEOUT_MS / 1000}`);
	}
	return seconds === 0 ? undefined : Math.max(1, Math.ceil(seconds * 1000));
}

/** Bounded UTF-16 tail with absolute offsets; never retain a severed surrogate pair. */
export class OutputTail {
	text = "";
	droppedChars = 0;
	constructor(readonly maxChars = OUTPUT_MAX_CHARS) {
		if (!Number.isInteger(maxChars) || maxChars < 2) throw new Error("Invalid output capacity");
	}
	append(text: string): void {
		this.text += text;
		let drop = Math.max(0, this.text.length - this.maxChars);
		if (drop && /[\uDC00-\uDFFF]/.test(this.text[drop])) drop++;
		if (drop) {
			this.text = this.text.slice(drop);
			this.droppedChars += drop;
		}
	}
}

/** Coalesce snapshots, but always flush the last dirty update and release timers. */
export function outputUpdates(emit: () => void, interval = UPDATE_INTERVAL_MS) {
	let timer: NodeJS.Timeout | undefined;
	let dirty = false;
	let last = -Infinity;
	let closed = false;
	const flush = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		if (!dirty) return;
		dirty = false;
		last = Date.now();
		emit();
	};
	return {
		mark() {
			if (closed) return;
			dirty = true;
			const delay = interval - (Date.now() - last);
			if (delay <= 0) flush();
			else timer ??= setTimeout(flush, delay);
		},
		finish() { closed = true; flush(); },
	};
}

/** Strip a private stdout control record incrementally, independently of output retention. */
export class CwdFilter {
	private pending = "";
	cwd: string | undefined;
	constructor(readonly marker: string, private readonly emit: (text: string) => void) {}
	write(text: string, final = false): void {
		this.pending += text;
		while (this.pending) {
			const index = this.pending.indexOf(this.marker);
			if (index >= 0) {
				this.emit(this.pending.slice(0, index));
				this.pending = this.pending.slice(index);
				const end = this.pending.indexOf("\n");
				if (end < 0 && !final && this.pending.length <= 32_768) return;
				if (end < 0 && !final) {
					// Malformed/oversized control record: bound parser memory too.
					this.emit(this.pending);
					this.pending = "";
					return;
				}
				this.cwd = this.pending.slice(this.marker.length, end < 0 ? undefined : end).trim() || undefined;
				this.pending = end < 0 ? "" : this.pending.slice(end + 1);
				continue;
			}
			let keep = 0;
			if (!final) {
				for (let n = Math.min(this.marker.length - 1, this.pending.length); n > 0; n--) {
					if (this.pending.endsWith(this.marker.slice(0, n))) { keep = n; break; }
				}
			}
			this.emit(this.pending.slice(0, this.pending.length - keep));
			this.pending = keep ? this.pending.slice(-keep) : "";
			return;
		}
	}
}

export interface ExecutionOutcome {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	aborted: boolean;
	spawnError?: string;
	cleanupError?: string;
	outputIncomplete: boolean;
	cwd?: string;
	droppedChars: number;
}
export class ExecutionLaunchError extends Error {
	constructor(message: string, readonly outcome: ExecutionOutcome) { super(message); }
}

export interface ExecutionOptions {
	executable: string;
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeout?: number;
	signal?: AbortSignal;
	captureCwd?: boolean;
	onData?: (text: string) => void;
}
export interface Execution {
	proc: ChildProcess;
	output: OutputTail;
	done: Promise<ExecutionOutcome>;
	stop: () => void;
}
export interface ExecutionOperations {
	spawn: typeof spawnPowerShell;
	kill: (pid: number) => void;
}

/** Single lifecycle/decoding/cancellation implementation for every shell surface. */
export function startExecution(options: ExecutionOptions, operations: ExecutionOperations = {
	spawn: spawnPowerShell, kill: killProcessTree,
}): Execution {
	const timeoutMs = timeoutMilliseconds(options.timeout);
	const state: ExecutionOutcome = {
		exitCode: null, signal: null, timedOut: false, aborted: false, outputIncomplete: false, droppedChars: 0,
	};
	if (options.signal?.aborted) {
		state.aborted = true;
		throw new ExecutionLaunchError("command aborted before launch", state);
	}
	const marker = options.captureCwd ? `\x01pwsh-cwd:${randomUUID()}:` : undefined;
	const output = new OutputTail();
	let proc: ChildProcess;
	try { proc = operations.spawn(options.executable, buildPowerShellScript(options.command, marker), options); }
	catch (error) {
		state.spawnError = String(error);
		throw new ExecutionLaunchError(`spawn error: ${state.spawnError}`, state);
	}
	let stopAfterExit: (() => void) | undefined;
	const stop = () => {
		if (stopAfterExit) stopAfterExit();
		// A failed-cleanup execution may have settled before its process later exited.
		else if (proc.pid && proc.exitCode == null && proc.signalCode == null) operations.kill(proc.pid);
	};
	const done = new Promise<ExecutionOutcome>((resolve) => {
		let settled = false;
		let exited = false;
		let timeout: NodeJS.Timeout | undefined;
		let idle: NodeJS.Timeout | undefined;
		const emit = (text: string) => {
			if (!text) return;
			output.append(text);
			options.onData?.(text);
		};
		const filter = marker ? new CwdFilter(marker, emit) : undefined;
		const streams = [proc.stdout, proc.stderr].map((stream, index) => {
			const decoder = new StringDecoder("utf8");
			let cr = false;
			let ended = !stream;
			const decoded = (text: string) => {
				if (!text) return; // An incomplete UTF-8 chunk must not reset CR state.
				if (cr && text.startsWith("\n")) text = text.slice(1);
				cr = text.endsWith("\r");
				text = text.replace(/\r\n?/g, "\n");
				if (index === 0 && filter) filter.write(text);
				else emit(text);
			};
			const data = (chunk: Buffer) => {
				if (settled) return;
				decoded(decoder.write(chunk));
				if (exited) armIdle();
			};
			const end = () => {
				if (ended) return;
				ended = true;
				decoded(decoder.end());
				if (exited && streams.every((item) => item.ended())) finish();
			};
			stream?.on("data", data);
			stream?.once("end", end);
			stream?.once("close", end);
			return { ended: () => ended, flush: end, dispose() {
				stream?.removeListener("data", data);
				stream?.removeListener("end", end);
				stream?.removeListener("close", end);
				stream?.destroy();
			} };
		});
		function finish() {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (idle) clearTimeout(idle);
			// A settled exited process must never be targeted later via a recycled PID.
			if (exited || state.spawnError) stopAfterExit = () => {};
			options.signal?.removeEventListener("abort", abort);
			proc.removeListener("error", error);
			proc.removeListener("exit", exit);
			proc.removeListener("close", close);
			for (const stream of streams) { stream.flush(); stream.dispose(); }
			filter?.write("", true);
			state.cwd = filter?.cwd;
			state.droppedChars = output.droppedChars;
			resolve(state);
		}
		function armIdle() {
			if (idle) clearTimeout(idle);
			idle = setTimeout(() => {
				state.outputIncomplete = streams.some((stream) => !stream.ended());
				finish();
			}, EXIT_IDLE_MS);
		}
		function terminate() {
			try { stop(); }
			catch (err) {
				state.cleanupError = String(err);
				state.outputIncomplete = true;
				finish();
			}
		}
		function abort() { state.aborted = true; terminate(); }
		function error(err: Error) { state.spawnError = err.message; finish(); }
		function exit(code: number | null, signal: NodeJS.Signals | null) {
			exited = true;
			state.exitCode = code;
			state.signal = signal;
			stopAfterExit = () => {
				state.outputIncomplete = streams.some((stream) => !stream.ended());
				finish();
			};
			// Keep the execution deadline and abort signal active during pipe draining.
			if (streams.every((stream) => stream.ended())) finish();
			else armIdle();
		}
		function close(code: number | null, signal: NodeJS.Signals | null) {
			exited = true;
			state.exitCode = code;
			state.signal = signal;
			finish();
		}
		proc.once("error", error);
		proc.once("exit", exit);
		proc.once("close", close);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (timeoutMs !== undefined) {
			timeout = setTimeout(() => { state.timedOut = true; terminate(); }, timeoutMs);
			timeout.unref?.();
		}
		if (options.signal?.aborted) abort();
	});
	return { proc, output, done, stop };
}

export function executionFailed(result: ExecutionOutcome): boolean {
	return result.exitCode !== 0 || result.timedOut || result.aborted || Boolean(result.spawnError || result.cleanupError);
}

export function executionNotes(result: ExecutionOutcome): string[] {
	const notes: string[] = [];
	if (result.spawnError) notes.push(`spawn error: ${result.spawnError}`);
	if (result.timedOut) notes.push("command timed out; process-tree termination requested");
	else if (result.aborted) notes.push("command aborted; process-tree termination requested");
	else if (result.exitCode !== 0) notes.push(`exit code: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`);
	if (result.cleanupError) notes.push(`process-tree cleanup error: ${result.cleanupError}`);
	if (result.outputIncomplete) notes.push("output capture ended before all pipes closed; late descendant output may be missing");
	if (result.droppedChars) notes.push(`output truncated: ${result.droppedChars} UTF-16 code units dropped from the in-memory buffer`);
	return notes;
}
