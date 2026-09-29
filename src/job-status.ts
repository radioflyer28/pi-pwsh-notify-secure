import type { ExecutionOutcome } from "./execution.js";

export interface JobState {
	running: boolean;
	killedByTool: boolean;
	timedOut: boolean;
	exitCode: number | null;
	outcome?: ExecutionOutcome;
	stopKind?: "termination_requested" | "capture_stopped";
}

/** One conservative projection for tools, notifications, and both job UIs. */
export function jobStatus(job: JobState): { state: string; text: string; ok: boolean } {
	if (job.outcome?.cleanupError) return { state: "cleanup_failed", text: "cleanup failed (process may still be running)", ok: false };
	if (job.outcome?.spawnError) return { state: "spawn_failed", text: "spawn failed", ok: false };
	if (job.killedByTool) return job.stopKind === "capture_stopped"
		? { state: "capture_stopped", text: "capture stopped (descendants may remain)", ok: false }
		: { state: "termination_requested", text: "termination requested", ok: false };
	if (job.running) return { state: "running", text: "running", ok: false };
	if (job.timedOut) return { state: "timed_out", text: "timeout (termination requested)", ok: false };
	if (job.outcome?.aborted) return { state: "aborted", text: "aborted", ok: false };
	if (job.outcome?.outputIncomplete) return { state: "capture_incomplete", text: `exited ${job.exitCode}; capture incomplete`, ok: false };
	return { state: "exited", text: `exited ${job.exitCode}`, ok: job.exitCode === 0 };
}

export function jobStatusText(job: JobState): string { return jobStatus(job).text; }
