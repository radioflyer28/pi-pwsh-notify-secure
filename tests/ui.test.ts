import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, { interopDefault: true });
const { JobList } = jiti(fileURLToPath(new URL("../src/ui/job-list.ts", import.meta.url)));
const { JobViewer } = jiti(fileURLToPath(new URL("../src/ui/job-viewer.ts", import.meta.url)));

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const tui = { terminal: { rows: 30 }, requestRender() {} };

function fakeJob(id = "bg-1", overrides: Record<string, unknown> = {}) {
	return {
		id,
		name: undefined,
		command: "npm run dev",
		cwd: process.env.TEMP ?? process.cwd(),
		proc: { pid: 1234 },
		output: "line1\nline2\n",
		baseOffset: 0,
		cursor: 0,
		pendingCarriageReturn: false,
		truncated: false,
		startedAt: Date.now() - 5_000,
		endedAt: undefined,
		exitCode: null,
		running: true,
		settling: false,
		killedByTool: false,
		timedOut: false,
		readyNotified: false,
		watchers: new Set<() => void>(),
		waiters: 0,
		terminalObserved: false,
		mutex: Promise.resolve(),
		...overrides,
	};
}

function makeListHarness() {
	const jobs = new Map<string, any>();
	const widgets: any[] = [];
	const killCalls: string[] = [];
	let handler: ((data: string) => unknown) | undefined;
	let editorText = "";
	let customCalls = 0;
	let viewer: any;
	let resolveCustom: ((value: undefined) => void) | undefined;
	const ui = {
		setWidget(key: string, content: unknown, options?: unknown) { widgets.push({ key, content, options }); },
		onTerminalInput(next: (data: string) => unknown) { handler = next; return () => { handler = undefined; }; },
		getEditorText() { return editorText; },
		notify() {},
		custom(factory: any) {
			customCalls++;
			viewer = factory(tui, theme, {}, () => {});
			return new Promise<undefined>((resolve) => { resolveCustom = resolve; });
		},
	};
	const list = new JobList(jobs, (job: any) => killCalls.push(job.id));
	list.setUICtx(ui);
	return {
		jobs, widgets, killCalls, list,
		get handler() { return handler!; },
		get editorText() { return editorText; },
		set editorText(value: string) { editorText = value; },
		get customCalls() { return customCalls; },
		get viewer() { return viewer; },
		closeViewer() { resolveCustom?.(undefined); },
	};
}

test("JobList navigation opens the viewer and respects empty-editor activation", async () => {
	const harness = makeListHarness();
	harness.jobs.set("bg-1", fakeJob("bg-1"));
	harness.jobs.set("bg-2", fakeJob("bg-2"));
	harness.list.update();
	const widget = harness.widgets.at(-1);
	widget.content(tui, theme);
	harness.editorText = "text";
	assert.equal(harness.handler("\x1b[C"), undefined);
	harness.editorText = "";
	assert.deepEqual(harness.handler("\x1b[C"), { consume: true });
	assert.deepEqual(harness.handler("\x1b[B"), { consume: true });
	assert.deepEqual(harness.handler("\r"), { consume: true });
	assert.equal(harness.customCalls, 1);
	assert.equal(harness.handler("\x1b[B"), undefined);
	harness.closeViewer();
	await sleep(0);
	assert.deepEqual(harness.handler("\x1b"), { consume: true });
	harness.list.dispose();
});

test("JobList rendering stays within terminal width", () => {
	const harness = makeListHarness();
	harness.jobs.set("bg-1", fakeJob("bg-1", { command: "very long command ".repeat(20) }));
	harness.list.update();
	const component = harness.widgets.at(-1).content(tui, theme);
	for (const width of [30, 60, 120]) {
		for (const line of component.render(width)) {
			const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
			assert.ok(plain.length <= width, `${plain.length} exceeds ${width}`);
		}
	}
	harness.list.dispose();
});

test("JobList finished jobs linger and then disappear", async () => {
	const harness = makeListHarness();
	harness.jobs.set("bg-1", fakeJob("bg-1", { running: false, exitCode: 0, endedAt: Date.now() }));
	harness.list.update();
	assert.ok(harness.widgets.at(-1).content);
	await sleep(4_200);
	harness.list.update();
	assert.equal(harness.widgets.at(-1).content, undefined);
	harness.list.dispose();
});

function makeViewer(overrides: Record<string, unknown> = {}) {
	const job = fakeJob("bg-1", {
		output: Array.from({ length: 100 }, (_, index) => `line${index}`).join("\r\n"),
		...overrides,
	});
	let renders = 0;
	let done = 0;
	let kills = 0;
	const localTui = { terminal: { rows: 30 }, requestRender() { renders++; } };
	const viewer = new JobViewer(localTui, job, theme, () => { done++; }, () => { kills++; });
	return { job, viewer, get renders() { return renders; }, get done() { return done; }, get kills() { return kills; } };
}

test("JobViewer supports scrolling, live refresh, bounded width, and disposal", () => {
	const harness = makeViewer();
	for (const key of ["home", "\x1b[B", "\x1b[A", "end", "\x1b[5~", "\x1b[6~"]) harness.viewer.handleInput(key);
	const lines = harness.viewer.render(80);
	assert.equal(lines.length, Math.floor((30 * 70) / 100));
	assert.ok(lines.every((line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").length <= 80));
	assert.ok(lines.every((line: string) => !line.includes("\r")));
	assert.equal(harness.job.watchers.size, 1);
	for (const watcher of harness.job.watchers) watcher();
	assert.ok(harness.renders > 0);
	harness.viewer.dispose();
	assert.equal(harness.job.watchers.size, 0);
});

test("JobViewer requires two consecutive kill presses and disables kill after finish", () => {
	const running = makeViewer();
	running.viewer.handleInput("x");
	assert.equal(running.kills, 0);
	running.viewer.handleInput("y");
	running.viewer.handleInput("x");
	running.viewer.handleInput("x");
	assert.equal(running.kills, 1);
	running.viewer.handleInput("\x1b");
	assert.equal(running.done, 1);
	running.viewer.dispose();

	const finished = makeViewer({ running: false, exitCode: 0, endedAt: Date.now() });
	finished.viewer.handleInput("x");
	finished.viewer.handleInput("x");
	assert.equal(finished.kills, 0);
	finished.viewer.dispose();
});
