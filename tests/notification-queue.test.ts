import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { NotificationQueue } from "../src/notification-queue.ts";

const item = (jobId: string, kind: "ready" | "finished" = "finished", content = jobId) => ({
	jobId,
	kind,
	content,
	details: { jobId },
});

test("notification queue batches successfully within item and character limits", async () => {
	const batches: string[][] = [];
	const queue = new NotificationQueue<{ jobId: string }>(
		(items) => batches.push(items.map((entry) => entry.jobId)),
		{ debounceMs: 5, maxItems: 2, maxChars: 8 },
	);
	queue.enqueue(item("one", "finished", "1111"));
	queue.enqueue(item("two", "finished", "2222"));
	queue.enqueue(item("three", "finished", "3333"));
	await sleep(40);
	assert.deepEqual(batches, [["one", "two"], ["three"]]);
	queue.dispose();
});

test("notification queue retries transient failure and delivers once", async () => {
	let attempts = 0;
	const sent: string[] = [];
	const queue = new NotificationQueue<{ jobId: string }>(
		(items) => {
			attempts++;
			if (attempts === 1) throw new Error("transient");
			sent.push(...items.map((entry) => entry.jobId));
		},
		{ debounceMs: 5, retryDelaysMs: [5], maxAttempts: 3 },
	);
	queue.enqueue(item("bg-1"));
	await sleep(40);
	assert.equal(attempts, 2);
	assert.deepEqual(sent, ["bg-1"]);
	queue.dispose();
});

test("notification queue reports permanent failures after finite attempts", async () => {
	let attempts = 0;
	const drops: number[] = [];
	const queue = new NotificationQueue<{ jobId: string }>(
		() => {
			attempts++;
			throw new Error("permanent");
		},
		{ debounceMs: 5, retryDelaysMs: [5], maxAttempts: 2, onDrop: (_error, count) => drops.push(count) },
	);
	queue.enqueue(item("bg-1"));
	await sleep(40);
	assert.equal(attempts, 2);
	assert.deepEqual(drops, [1]);
	queue.dispose();
});

test("notification queue cancellation removes selected job event kinds", async () => {
	const sent: string[] = [];
	const queue = new NotificationQueue<{ jobId: string }>(
		(items) => sent.push(...items.map((entry) => `${entry.jobId}:${entry.kind}`)),
		{ debounceMs: 20 },
	);
	queue.enqueue(item("bg-1", "ready"));
	queue.enqueue(item("bg-1", "finished"));
	queue.enqueue(item("bg-2", "finished"));
	assert.equal(queue.cancel("bg-1", ["ready"]), 1);
	await sleep(40);
	assert.deepEqual(sent, ["bg-1:finished", "bg-2:finished"]);
	queue.dispose();
});

test("notification queue disposal cancels pending delivery and rejects new work", async () => {
	let sends = 0;
	const queue = new NotificationQueue(() => { sends++; }, { debounceMs: 10 });
	queue.enqueue(item("bg-1"));
	queue.dispose();
	queue.enqueue(item("bg-2"));
	await sleep(30);
	assert.equal(sends, 0);
});

test("notification queue drops a single oversized event locally", async () => {
	let sends = 0;
	let dropped = 0;
	const queue = new NotificationQueue(
		() => { sends++; },
		{ debounceMs: 5, maxChars: 3, onDrop: (_error, count) => { dropped += count; } },
	);
	queue.enqueue(item("bg-1", "finished", "toolong"));
	await sleep(20);
	assert.equal(sends, 0);
	assert.equal(dropped, 1);
	queue.dispose();
});
