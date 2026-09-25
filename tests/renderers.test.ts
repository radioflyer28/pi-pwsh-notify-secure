import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { initTheme, type AgentToolResult, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, visibleWidth, type KeyId } from "@earendil-works/pi-tui";
import {
	renderPowerShellResult,
	renderPwshCall,
	renderPwshJobCall,
	renderVisible,
	type PowerShellRenderContext,
	type PowerShellRendererState,
} from "../src/ui/powershell-tool-renderers.ts";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, { interopDefault: true });
const extensionModule = jiti(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
const pwshNotifyExtension = extensionModule.default ?? extensionModule;

initTheme();

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function installExpandBinding(key: KeyId): void {
	setKeybindings(
		new KeybindingsManager(
			{ "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tools" } },
			{ "app.tools.expand": key },
		),
	);
}

function context<TArgs>(args: TArgs, overrides: Partial<PowerShellRenderContext<TArgs>> = {}): PowerShellRenderContext<TArgs> {
	return {
		args,
		toolCallId: "call-1",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "C:/work",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	};
}

function result(text: string, details: unknown = undefined): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value;
}

function modelProjection(tool: Record<string, unknown>): string {
	return JSON.stringify({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		promptSnippet: tool.promptSnippet,
		promptGuidelines: tool.promptGuidelines,
	});
}

function registeredTools(): Map<string, Record<string, unknown>> {
	const tools = new Map<string, Record<string, unknown>>();
	const noop = () => {};
	pwshNotifyExtension({
		registerTool(tool: Record<string, unknown>) {
			tools.set(String(tool.name), tool);
		},
		on: noop,
		registerMessageRenderer: noop,
		getActiveTools: () => [],
		setActiveTools: noop,
		sendMessage: noop,
	} as never);
	return tools;
}

function assertWidth(lines: string[], width: number): void {
	assert.ok(lines.length > 0);
	for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
}

test("pwsh and pwsh_job register display-only custom renderers", () => {
	const tools = registeredTools();
	for (const name of ["pwsh", "pwsh_job"]) {
		const tool = tools.get(name);
		assert.ok(tool, `${name} registered`);
		assert.equal(typeof tool.renderCall, "function");
		assert.equal(typeof tool.renderResult, "function");
		assert.notEqual(tool.renderShell, "self");
	}
});

test("rendering preserves both tools' model-visible definitions, calls, results, and details", () => {
	installExpandBinding("ctrl+o");
	const tools = registeredTools();
	const cases = [
		{
			name: "pwsh",
			args: deepFreeze({ command: "Write-Output secret", timeout: 3, run_in_background: false }),
			renderCall: renderPwshCall,
		},
		{
			name: "pwsh_job",
			args: deepFreeze({ action: "wait", id: "bg-1", pattern: "secret|ready", timeout: 4 }),
			renderCall: renderPwshJobCall,
		},
	] as const;

	for (const item of cases) {
		const toolResult = deepFreeze(result("line one\nline two", { sentinel: `${item.name}-unchanged` }));
		const before = {
			tool: modelProjection(tools.get(item.name)!),
			args: JSON.stringify(item.args),
			result: JSON.stringify(toolResult),
			request: JSON.stringify({ name: item.name, arguments: item.args }),
		};
		for (const expanded of [false, true]) {
			const callContext = context(item.args, { expanded });
			renderVisible(item.renderCall(item.args as never, theme, callContext as never), 24);
			const resultContext = context(item.args, { expanded, state: callContext.state });
			renderVisible(renderPowerShellResult(toolResult, { expanded, isPartial: false }, theme, resultContext), 24);
		}
		assert.deepEqual(
			{
				tool: modelProjection(tools.get(item.name)!),
				args: JSON.stringify(item.args),
				result: JSON.stringify(toolResult),
				request: JSON.stringify({ name: item.name, arguments: item.args }),
			},
			before,
		);
	}
});

test("pwsh command and result render together without replacing invocation context", () => {
	const args = deepFreeze({ command: "Write-Output combined" });
	const state: PowerShellRendererState = {};
	const call = renderVisible(renderPwshCall(args, theme, context(args, { state })), 80);
	const output = renderVisible(
		renderPowerShellResult(result("combined"), { expanded: false, isPartial: false }, theme, context(args, { state })),
		80,
	);
	assert.match([...call, ...output].join("\n"), /PS> Write-Output combined[\s\S]*Done[\s\S]*combined/);
});

test("pwsh calls show command context, options, head clipping, and complete expansion", () => {
	installExpandBinding("ctrl+o");
	const args = deepFreeze({
		command: "Get-ChildItem -Recurse\nWhere-Object Length -gt 0\nSelect-Object -First 20\nFormat-Table",
		run_in_background: true,
		name: "scan",
		timeout: 9,
		notify_on: "ready|listening",
	});
	const collapsed = renderVisible(renderPwshCall(args, theme, context(args)), 32);
	assert.match(collapsed.join("\n"), /PS>/);
	assert.match(collapsed.join("\n"), /Get-ChildItem/);
	assert.match(collapsed.join("\n"), /ctrl\+o to expand/);
	assert.doesNotMatch(collapsed.join("\n"), /Format-Table/);
	assertWidth(collapsed, 32);

	const expanded = renderVisible(renderPwshCall(args, theme, context(args, { expanded: true })), 32);
	assert.match(expanded.join("\n"), /Format-Table/);
	assert.match(expanded.join("\n"), /background/);
	assert.match(expanded.join("\n"), /name scan/);
	assert.match(expanded.join("\n"), /timeout\s+9s/);
	assert.match(expanded.join("\n"), /notify \/ready\|listening\//);
	assertWidth(expanded, 32);
});

test("pwsh call renderer is defensive and width-safe for partial Unicode arguments", () => {
	const args = deepFreeze({ command: "界e\u0301🙂".repeat(12), timeout: Number.NaN });
	for (const width of [1, 8, 15]) {
		const lines = renderVisible(renderPwshCall(args, theme, context(args, { argsComplete: false })), width);
		assertWidth(lines, width);
	}
	const malformed = deepFreeze({ command: 42, run_in_background: "yes" });
	assert.doesNotThrow(() => renderVisible(renderPwshCall(malformed, theme, context(malformed)), 10));
});

test("pwsh_job calls summarize every action and expand long wait values", () => {
	installExpandBinding("ctrl+o");
	const fixtures = [
		[{ action: "list" }, /job list/],
		[{ action: "output", id: "bg-1", lines: 100 }, /job output bg-1 · 100 lines/],
		[{ action: "output", id: "bg-2", lines: 0 }, /all buffered lines/],
		[{ action: "kill", id: "bg-3" }, /job kill bg-3/],
	] as const;
	for (const [args, pattern] of fixtures) {
		assert.match(renderVisible(renderPwshJobCall(args, theme, context(args)), 80).join("\n"), pattern);
	}

	const waitArgs = deepFreeze({ action: "wait", id: "bg-very-long-identifier", pattern: "ready|listening|started|accepting", timeout: 120 });
	const collapsed = renderVisible(renderPwshJobCall(waitArgs, theme, context(waitArgs)), 20);
	assert.match(collapsed.join("\n"), /job wait/);
	assert.match(collapsed.join("\n"), /to expand/);
	assertWidth(collapsed, 20);
	const expanded = renderVisible(renderPwshJobCall(waitArgs, theme, context(waitArgs, { expanded: true })), 20);
	assert.match(expanded.join("\n"), /accepting/);
	assert.match(expanded.join("\n"), /120s/);
	assertWidth(expanded, 20);

	const malformed = deepFreeze({ action: 7, id: { bad: true }, pattern: ["bad"] });
	assert.doesNotThrow(() => renderVisible(renderPwshJobCall(malformed, theme, context(malformed)), 12));
	assert.match(renderVisible(renderPwshJobCall(malformed, theme, context(malformed)), 12).join("\n"), /job \?/);
});

test("collapsed results show a five-visual-line tail and configured expansion hint", () => {
	installExpandBinding("alt+x");
	const output = ["old-1", "old-2", "new-1", "界界界界", "e\u0301", "\u001b[31mnew-4\u001b[0m", "new-5"].join("\n");
	const toolResult = deepFreeze(result(output));
	const ctx = context({}, { state: { startedAt: Date.now() - 1000 } });
	const lines = renderVisible(renderPowerShellResult(toolResult, { expanded: false, isPartial: false }, theme, ctx), 16);
	assert.match(lines.join("\n"), /earlier lines/);
	assert.match(lines.join("\n"), /alt\+x to expand/);
	assert.doesNotMatch(lines.join("\n"), /old-1/);
	assert.match(lines.join("\n"), /new-5/);
	assertWidth(lines, 16);

	const short = renderVisible(renderPowerShellResult(result("one\ntwo"), { expanded: false, isPartial: false }, theme, context({})), 20);
	assert.doesNotMatch(short.join("\n"), /to expand|earlier/);
});

test("expanded and error results retain all available diagnostic text", () => {
	const diagnostics = [
		"command timed out after 2s",
		"command aborted",
		"exit code: 3",
		"wait timed out; job remains running",
		"Invalid pattern regex: unterminated group",
	];
	for (const message of diagnostics) {
		const toolResult = deepFreeze(result(message, { stable: true }));
		for (const expanded of [false, true]) {
			const ctx = context({}, { expanded, isError: true, state: { startedAt: Date.now() - 2000 } });
			const lines = renderVisible(renderPowerShellResult(toolResult, { expanded, isPartial: false }, theme, ctx), 80);
			assert.match(lines.join("\n"), /Failed/);
			assert.ok(lines.join("\n").includes(message));
		}
	}
	assert.match(
		renderVisible(
			renderPowerShellResult(result("[output truncated: showing bounded tail]"), { expanded: true, isPartial: false }, theme, context({}, { expanded: true })),
			80,
		).join("\n"),
		/output truncated/,
	);
});

test("README documents both tool renderers and Pi's configurable expansion action", () => {
	const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
	assert.match(readme, /Both `pwsh` and `pwsh_job` use purpose-built TUI rendering/);
	assert.match(readme, /`app\.tools\.expand` action \(`Ctrl-O` by default\)/);
	assert.match(readme, /UI-only/);
});

test("partial result timing invalidates, reuses components, and cleans up", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000 });
	let invalidations = 0;
	const state: PowerShellRendererState = { startedAt: Date.now() };
	const ctx = context({}, { isPartial: true, state, invalidate: () => invalidations++ });
	const partial = renderPowerShellResult(result("streaming"), { expanded: false, isPartial: true }, theme, ctx);
	assert.ok(state.interval);
	t.mock.timers.tick(1_000);
	assert.equal(invalidations, 1);
	assert.match(renderVisible(partial, 40).join("\n"), /Running · Elapsed 1\.0s/);

	ctx.lastComponent = partial;
	const reused = renderPowerShellResult(result("streaming\nmore"), { expanded: false, isPartial: true }, theme, ctx);
	assert.equal(reused, partial);
	renderPowerShellResult(result("done"), { expanded: false, isPartial: false }, theme, { ...ctx, isPartial: false });
	assert.equal(state.interval, undefined);
	assert.ok(state.endedAt);

	const errorState: PowerShellRendererState = { startedAt: Date.now() };
	renderPowerShellResult(
		result("failed"),
		{ expanded: false, isPartial: true },
		theme,
		context({}, { isPartial: true, isError: true, state: errorState }),
	);
	assert.equal(errorState.interval, undefined);
	assert.ok(errorState.endedAt);

	const disposableState: PowerShellRendererState = { startedAt: Date.now() };
	const disposable = renderPowerShellResult(
		result("active"),
		{ expanded: false, isPartial: true },
		theme,
		context({}, { isPartial: true, state: disposableState }),
	) as { dispose?: () => void };
	assert.ok(disposableState.interval);
	disposable.dispose?.();
	assert.equal(disposableState.interval, undefined);
});
