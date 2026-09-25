import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

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
const call = (name: string, params: Record<string, unknown>) =>
	tools.get(name).execute("manual", params, undefined, undefined, ctx);
const textOf = (result: any) => result.content[0].text as string;

await emit("session_start");
const foreground = textOf(await call("pwsh", { command: "Write-Output FOREGROUND_EXPLICIT" }));
assert.match(foreground, /FOREGROUND_EXPLICIT/);

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
	foreground: "explicit output observed",
	automatic: "ready and finished metadata-only",
	explicitWait: "ready output and completed state observed",
	shutdown: `PID ${pid} reaped`,
}, null, 2));
