import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { ExecutionOutcome } from "./execution.js";
import { jobStatus, type JobState } from "./job-status.js";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const executionSchema = Type.Object({
	exit_code: Type.Union([Type.Number(), Type.Null()]),
	signal: nullableString, timed_out: Type.Boolean(), aborted: Type.Boolean(),
	output_incomplete: Type.Boolean(), spawn_error: nullableString, cleanup_error: nullableString,
	cwd: nullableString,
});
const outputSchema = Type.Object({
	output: Type.String(),
	buffer_dropped_utf16: Type.Number(),
	result_omitted_utf16: Type.Number(),
	unseen_lost: Type.Boolean(),
});
const jobSchema = Type.Object({
	job_id: Type.String(), state: Type.String(), running: Type.Boolean(),
	pid: Type.Union([Type.Number(), Type.Null()]),
	elapsed_seconds: Type.Number(),
	execution: Type.Union([executionSchema, Type.Null()]),
});
export const pwshOutputSchema = Type.Union([
	Type.Object({ kind: Type.Literal("foreground"), ...outputSchema.properties,
		execution: executionSchema, elapsed_seconds: Type.Number() }),
	Type.Object({ kind: Type.Literal("background"), job: jobSchema }),
]);
export const jobOutputSchema = Type.Union([
	Type.Object({ kind: Type.Literal("list"), jobs: Type.Array(jobSchema), omitted_jobs: Type.Number() }),
	Type.Object({ kind: Type.Literal("stop"), job: jobSchema,
		stop_outcome: Type.Union([Type.Literal("already_finished"), Type.Literal("termination_requested"), Type.Literal("capture_stopped")]) }),
	Type.Object({ kind: Type.Literal("output"), job: jobSchema, ...outputSchema.properties,
		cursor_from_utf16: Type.Number(), cursor_to_utf16: Type.Number(), replay: Type.Boolean() }),
	Type.Object({ kind: Type.Literal("wait"), job: jobSchema, ...outputSchema.properties,
		cursor_from_utf16: Type.Number(), cursor_to_utf16: Type.Number(),
		wait_outcome: Type.Union([Type.Literal("matched"), Type.Literal("exited"), Type.Literal("timeout"), Type.Literal("aborted")]) }),
]);
export type PwshResult = Static<typeof pwshOutputSchema>;
export type JobResult = Static<typeof jobOutputSchema>;

export function executionData(outcome: ExecutionOutcome): Static<typeof executionSchema> {
	return {
		exit_code: outcome.exitCode, signal: outcome.signal, timed_out: outcome.timedOut, aborted: outcome.aborted,
		output_incomplete: outcome.outputIncomplete, spawn_error: outcome.spawnError ?? null,
		cleanup_error: outcome.cleanupError ?? null, cwd: outcome.cwd ?? null,
	};
}

export function jobData(job: JobState & { id: string; proc: { pid?: number }; startedAt: number; endedAt?: number }): Static<typeof jobSchema> {
	return { job_id: job.id, state: jobStatus(job).state, running: job.running, pid: job.proc.pid ?? null,
		elapsed_seconds: Math.max(0, (job.endedAt ?? Date.now()) - job.startedAt) / 1000,
		execution: job.outcome ? executionData(job.outcome) : null };
}

/** Select output ONCE for both views. No new retention budget, placeholders, or diagnostics in machine output. */
export function outputSnapshot(source: string, options: {
	prefix?: string; notes?: string[]; maxLines?: number; dropped?: number; missed?: boolean;
} = {}) {
	const prefix = truncateTail(options.prefix ?? "", { maxBytes: 4096, maxLines: 20 }).content;
	const notes = truncateTail((options.notes ?? []).join("\n"), { maxBytes: 4096, maxLines: 20 }).content;
	const overhead = [prefix, notes].filter(Boolean).join("\n\n");
	const result = truncateTail(source, {
		maxBytes: Math.max(1, DEFAULT_MAX_BYTES - Buffer.byteLength(overhead, "utf8") - 512),
		maxLines: Math.max(1, Math.min(options.maxLines ?? DEFAULT_MAX_LINES,
			DEFAULT_MAX_LINES - overhead.split("\n").length - 5)),
	});
	// JSON escaping can expand control-heavy output sixfold. Do not introduce a larger script-facing budget.
	let selected = result.content;
	const jsonBudget = DEFAULT_MAX_BYTES - 8192;
	if (Buffer.byteLength(JSON.stringify(selected), "utf8") > jsonBudget) {
		let lo = 0, hi = selected.length;
		while (lo < hi) {
			const mid = Math.floor((lo + hi) / 2);
			if (Buffer.byteLength(JSON.stringify(selected.slice(mid)), "utf8") > jsonBudget) lo = mid + 1;
			else hi = mid;
		}
		if (/[\uDC00-\uDFFF]/.test(selected[lo] ?? "")) lo++;
		selected = selected.slice(lo);
	}
	const omitted = source.length - selected.length;
	const marker = omitted > 0 ? `[output truncated: ${omitted} UTF-16 code units omitted from this result]` : "";
	return {
		text: [prefix, marker, selected.trim() || "(no output)", notes].filter(Boolean).join("\n\n"),
		data: { output: selected, buffer_dropped_utf16: options.dropped ?? 0,
			result_omitted_utf16: Math.max(0, omitted), unseen_lost: options.missed ?? false },
	};
}

/** Added properties are ignored by older Pi versions; keep the legacy error hook for those hosts. */
export function structuredResult(text: string, structuredContent: PwshResult | JobResult, details?: ExecutionOutcome) {
	return { content: [{ type: "text" as const, text }], details, structuredContent };
}
