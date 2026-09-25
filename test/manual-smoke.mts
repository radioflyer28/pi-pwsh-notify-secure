import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";

initTheme();
setKeybindings(
	new KeybindingsManager(
		{ "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tools" } },
		{ "app.tools.expand": "ctrl+o" },
	),
);

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, { interopDefault: true });
const extensionModule = jiti(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
const extension = extensionModule.default ?? extensionModule;
const cwd = fileURLToPath(new URL("..", import.meta.url));
const tools = new Map<string, any>();
const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
const messages: any[] = [];
let activeTools = ["read", "bash", "powershell"];
const ui = {
	setStatus() {}, setWidget() {}, getEditorText() { return ""; }, notify() {}, async custom() {},
	onTerminalInput() { return () => {}; },
};
const pi = {
	registerTool(definition: any) { tools.set(definition.name, definition); activeTools.push(definition.name); },
	registerMessageRenderer() {},
	on(event: string, handler: (event: any, ctx: any) => unknown) {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
	sendMessage(message: any, options: any) { messages.push({ message, options }); },
	getActiveTools() { return [...activeTools]; },
	setActiveTools(next: string[]) { activeTools = [...next]; },
};
const ctx = {
	cwd, hasUI: false, mode: "rpc", ui,
	sessionManager: { getSessionId: () => "manual-smoke", getSessionFile: () => `${cwd}/manual-smoke.jsonl` },
	model: { provider: "manual", id: "smoke" }, thinkingLevel: "off",
};
extension(pi);
const emit = async (event: string) => {
	for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
};
const call = (name: string, params: Record<string, unknown>, onUpdate?: (result: any) => void) =>
	tools.get(name).execute("manual", params, undefined, onUpdate, ctx);
const textOf = (result: any) => result.content[0].text as string;
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const renderContext = (args: Record<string, unknown>, expanded: boolean, overrides: Record<string, unknown> = {}) => ({
	args,
	toolCallId: "manual-render",
	invalidate() {},
	lastComponent: undefined,
	state: {},
	cwd,
	executionStarted: true,
	argsComplete: true,
	isPartial: false,
	expanded,
	showImages: false,
	isError: false,
	...overrides,
});
const assertRendered = (component: any, width: number, expected: RegExp) => {
	const lines = component.render(width) as string[];
	assert.match(lines.join("\n"), expected);
	assert.ok(lines.every((line) => visibleWidth(line) <= width));
};

await emit("session_start");
const foregroundArgs = { command: "Write-Output FOREGROUND_EXPLICIT" };
const foregroundResult = await call("pwsh", foregroundArgs);
const foreground = textOf(foregroundResult);
assert.match(foreground, /FOREGROUND_EXPLICIT/);

const updates: any[] = [];
const streamingArgs = { command: "Write-Output STREAM_ONE; Start-Sleep -Milliseconds 150; Write-Output STREAM_TWO" };
const streamingResult = await call("pwsh", streamingArgs, (update) => updates.push(update));
assert.ok(updates.length > 0);
assert.match(textOf(streamingResult), /STREAM_ONE[\s\S]*STREAM_TWO/);

const failureArgs = { command: "Write-Error FAILURE_EXPLICIT; exit 3" };
const failureResult = await call("pwsh", failureArgs);
assert.match(textOf(failureResult), /FAILURE_EXPLICIT/);
assert.match(textOf(failureResult), /exit code: 3/);

for (const width of [80, 20]) {
	for (const [args, expected] of [[foregroundArgs, /PS>/], [streamingArgs, /PS>/], [failureArgs, /PS>/]] as const) {
		assertRendered(tools.get("pwsh").renderCall(args, theme, renderContext(args, false)), width, expected);
	}
	assertRendered(
		tools.get("pwsh").renderResult(foregroundResult, { expanded: false, isPartial: false }, theme, renderContext(foregroundArgs, false)),
		width,
		/FOREGROUND_EXPLICIT/,
	);
	assertRendered(
		tools.get("pwsh").renderResult(updates.at(-1), { expanded: false, isPartial: true }, theme, renderContext(streamingArgs, false, { isPartial: true })),
		width,
		/Running/,
	);
	assertRendered(
		tools.get("pwsh").renderResult(failureResult, { expanded: true, isPartial: false }, theme, renderContext(failureArgs, true, { isError: true })),
		width,
		/Failed/,
	);
}

await call("pwsh", {
	command: "Write-Output READY_SECRET_OUTPUT; Start-Sleep -Milliseconds 300; Write-Output FINISHED_SECRET_OUTPUT",
	run_in_background: true,
	notify_on: "READY_SECRET_OUTPUT",
});
await sleep(1_800);
const automatic = JSON.stringify(messages);
assert.match(automatic, /background-job-ready/);
assert.match(automatic, /background-job-finished/);
assert.doesNotMatch(automatic, /READY_SECRET_OUTPUT|FINISHED_SECRET_OUTPUT|Write-Output/);

await call("pwsh", {
	command: "Write-Output WAIT_READY; Start-Sleep -Milliseconds 300; Write-Output WAIT_DONE",
	run_in_background: true,
	notify_on: "WAIT_READY",
});
const readyWait = textOf(await call("pwsh_job", { action: "wait", id: "bg-2", pattern: "WAIT_READY" }));
assert.match(readyWait, /WAIT_READY/);
const finishedWait = textOf(await call("pwsh_job", { action: "wait", id: "bg-2" }));
assert.match(finishedWait, /exited 0/);
assert.match(finishedWait, /WAIT_DONE/);

await call("pwsh", {
	command: "Write-Output OUTPUT_ACTION; Start-Sleep -Seconds 30",
	run_in_background: true,
	name: "action-smoke",
});
await sleep(500);
const listed = textOf(await call("pwsh_job", { action: "list" }));
assert.match(listed, /bg-3/);
const output = textOf(await call("pwsh_job", { action: "output", id: "bg-3", lines: 10 }));
assert.match(output, /OUTPUT_ACTION/);
const killed = textOf(await call("pwsh_job", { action: "kill", id: "bg-3" }));
assert.match(killed, /Killed bg-3/);

const actionArgs = [
	{ action: "list" },
	{ action: "output", id: "bg-3", lines: 10 },
	{ action: "wait", id: "bg-2", pattern: "WAIT_READY", timeout: 120 },
	{ action: "kill", id: "bg-3" },
];
for (const width of [80, 20]) {
	for (const args of actionArgs) {
		assertRendered(tools.get("pwsh_job").renderCall(args, theme, renderContext(args, false)), width, /job/);
	}
	for (const actionResult of [
		{ content: [{ type: "text", text: listed }], details: undefined },
		{ content: [{ type: "text", text: output }], details: undefined },
		{ content: [{ type: "text", text: finishedWait }], details: undefined },
		{ content: [{ type: "text", text: killed }], details: undefined },
	]) {
		assertRendered(
			tools.get("pwsh_job").renderResult(actionResult, { expanded: false, isPartial: false }, theme, renderContext({}, false)),
			width,
			/Done/,
		);
	}
}

const longStart = textOf(await call("pwsh", {
	command: "Start-Sleep -Seconds 30",
	run_in_background: true,
}));
const pid = Number(longStart.match(/PID (\d+)/)?.[1]);
assert.ok(Number.isInteger(pid) && pid > 0);
await emit("session_shutdown");
await sleep(200);
let orphaned = true;
try { process.kill(pid, 0); } catch { orphaned = false; }
assert.equal(orphaned, false, `background process ${pid} survived session shutdown`);

console.log(JSON.stringify({
	foreground: "success, failure, and streaming output observed",
	automatic: "ready and finished metadata-only",
	explicitWait: "ready output and completed state observed",
	jobActions: "list, output, wait, and kill exercised",
	rendering: "pwsh and pwsh_job rendered at 80 and 20 columns",
	shutdown: `PID ${pid} reaped`,
}, null, 2));
