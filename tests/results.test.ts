import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Check } from "typebox/value";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

const jiti = createRequire(import.meta.url)("jiti")(import.meta.url, { interopDefault: true });
const { outputSnapshot, executionData, jobData, pwshOutputSchema, jobOutputSchema } = jiti(fileURLToPath(new URL("../src/results.ts", import.meta.url)));
const { jobStatus } = jiti(fileURLToPath(new URL("../src/job-status.ts", import.meta.url)));
const outcome = { exitCode: 0, signal: null, timedOut: false, aborted: false, outputIncomplete: false, droppedChars: 0 };
const job = { id: "bg-1", proc: {}, startedAt: Date.now(), running: false, killedByTool: false, timedOut: false, exitCode: 0, outcome };

test("structured output is bounded independently of buffer eviction and preserves whitespace", () => {
	for (const source of ["", "  x \n", "😀中".repeat(80_000), "row\n".repeat(4000), "\u0000".repeat(60_000)]) {
		const r = outputSnapshot(source, { prefix: "job header", notes: ["diagnostic"], dropped: 42, missed: true });
		assert.ok(Buffer.byteLength(r.text) <= DEFAULT_MAX_BYTES);
		assert.ok(r.text.split("\n").length <= DEFAULT_MAX_LINES);
		assert.ok(Buffer.byteLength(r.data.output) <= DEFAULT_MAX_BYTES);
		assert.ok(Buffer.byteLength(JSON.stringify(r.data)) <= DEFAULT_MAX_BYTES);
		assert.equal(r.data.buffer_dropped_utf16, 42);
		assert.equal(r.data.result_omitted_utf16, source.length - r.data.output.length);
		assert.equal(r.data.unseen_lost, true);
		assert.ok(!r.data.output.includes("diagnostic"));
		assert.ok(!/^[\uDC00-\uDFFF]/.test(r.data.output));
		if (source.length < 100) assert.equal(r.data.output, source);
	}
});

test("output line limit counts omitted data and never creates log paths", () => {
	const snapshot = outputSnapshot("one\ntwo\nthree", { maxLines: 1 });
	assert.equal(snapshot.data.output, "three");
	assert.equal(snapshot.data.result_omitted_utf16, 8);
	assert.doesNotMatch(JSON.stringify(snapshot), /full_output_path|\.log/);
});

test("every declared result kind validates and JSON round-trips including failed executions", () => {
	const exec = executionData({ ...outcome, exitCode: 7, cleanupError: "cleanup failed" });
	const output = outputSnapshot("failure").data;
	const j = jobData(job);
	const values = [
		[pwshOutputSchema, { kind: "foreground", ...output, execution: exec, elapsed_seconds: 1 }],
		[pwshOutputSchema, { kind: "background", job: j }],
		[jobOutputSchema, { kind: "list", jobs: [j], omitted_jobs: 0 }],
		[jobOutputSchema, { kind: "stop", job: j, stop_outcome: "capture_stopped" }],
		[jobOutputSchema, { kind: "output", job: j, ...output, cursor_from_utf16: 0, cursor_to_utf16: 7, replay: false }],
		[jobOutputSchema, { kind: "wait", job: j, ...output, cursor_from_utf16: 0, cursor_to_utf16: 7, wait_outcome: "timeout" }],
	];
	for (const [schema, data] of values) assert.ok(Check(schema, JSON.parse(JSON.stringify(data))));
	assert.equal(exec.exit_code, 7); assert.equal(exec.cleanup_error, "cleanup failed");
	assert.equal(j.execution.timed_out, false); // wait timeout != process timeout
});

test("status prioritizes cleanup failures over stop flags and never claims a kill", () => {
	assert.equal(jobStatus({ ...job, killedByTool: true, outcome: { ...outcome, cleanupError: "denied" } }).state, "cleanup_failed");
	assert.equal(jobStatus({ ...job, outcome: { ...outcome, spawnError: "not found" } }).state, "spawn_failed");
	assert.equal(jobStatus({ ...job, killedByTool: true, stopKind: "capture_stopped" }).state, "capture_stopped");
	assert.equal(jobStatus({ ...job, killedByTool: true, running: true }).state, "termination_requested");
	assert.equal(jobStatus({ ...job, timedOut: true }).state, "timed_out");
	assert.equal(jobStatus({ ...job, outcome: { ...outcome, outputIncomplete: true } }).ok, false);
	assert.equal(jobStatus(job).ok, true);
});
