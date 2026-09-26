import {
	keyHint,
	truncateToVisualLines,
	type AgentToolResult,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";

const CALL_PREVIEW_LINES = 3;
const RESULT_PREVIEW_LINES = 5;

export interface PwshRenderArgs {
	command?: unknown;
	run_in_background?: unknown;
	timeout?: unknown;
	name?: unknown;
	notify_on?: unknown;
}

export interface PwshJobRenderArgs {
	action?: unknown;
	id?: unknown;
	lines?: unknown;
	pattern?: unknown;
	timeout?: unknown;
}

export interface PowerShellRendererState {
	startedAt?: number;
	endedAt?: number;
	interval?: NodeJS.Timeout;
}

/** Public renderer context shape supplied by Pi's registerTool contract. */
export interface PowerShellRenderContext<TArgs = unknown> {
	args: TArgs;
	toolCallId: string;
	invalidate: () => void;
	lastComponent: Component | undefined;
	state: PowerShellRendererState;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	showImages: boolean;
	isError: boolean;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const whole = Math.floor(seconds);
	const minutes = Math.floor(whole / 60);
	const remainder = whole % 60;
	return minutes < 60 ? `${minutes}m ${remainder}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function expansionLabels(hidden: number, direction: "more" | "earlier"): [string, string] {
	const noun = hidden === 1 ? "line" : "lines";
	return [`…${hidden} ${direction} ${noun}`, keyHint("app.tools.expand", "to expand")];
}

function fitLines(lines: string[], width: number): string[] {
	const safeWidth = Math.max(1, width);
	return lines.map((line) =>
		visibleWidth(line) <= safeWidth ? line : truncateToWidth(line, safeWidth, safeWidth > 1 ? "…" : ""),
	);
}

function renderHead(text: string, width: number, expanded: boolean, maxLines = CALL_PREVIEW_LINES): string[] {
	const safeWidth = Math.max(1, width);
	const lines = wrapTextWithAnsi(text, safeWidth);
	if (expanded || lines.length <= maxLines) return fitLines(lines, safeWidth);
	const shown = lines.slice(0, maxLines);
	return fitLines([...shown, ...expansionLabels(lines.length - shown.length, "more")], safeWidth);
}

function textOutput(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

class PowerShellCallComponent implements Component {
	private text = "";
	private expanded = false;
	private cachedWidth?: number;
	private cachedLines?: string[];

	update(text: string, expanded: boolean): void {
		if (text === this.text && expanded === this.expanded) return;
		this.text = text;
		this.expanded = expanded;
		this.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		if (this.cachedWidth === safeWidth && this.cachedLines) return this.cachedLines;
		this.cachedWidth = safeWidth;
		this.cachedLines = renderHead(this.text, safeWidth, this.expanded);
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

class PowerShellResultComponent implements Component {
	private result?: AgentToolResult<unknown>;
	private output = "";
	private options: ToolRenderResultOptions = { expanded: false, isPartial: false };
	private theme!: Theme;
	private context!: PowerShellRenderContext<unknown>;
	private isError = false;
	private startedAt?: number;
	private endedAt?: number;
	private cachedWidth?: number;
	private cachedTimeSecond?: number;
	private cachedLines?: string[];

	update(
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: PowerShellRenderContext<unknown>,
	): void {
		const resultChanged = result !== this.result;
		const changed =
			resultChanged ||
			options.expanded !== this.options.expanded ||
			options.isPartial !== this.options.isPartial ||
			theme !== this.theme ||
			context.isError !== this.isError ||
			context.state.startedAt !== this.startedAt ||
			context.state.endedAt !== this.endedAt;
		this.result = result;
		if (resultChanged) this.output = textOutput(result).trim();
		this.options = { expanded: options.expanded, isPartial: options.isPartial };
		this.theme = theme;
		this.context = context;
		this.isError = context.isError;
		this.startedAt = context.state.startedAt;
		this.endedAt = context.state.endedAt;
		if (changed) this.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const timeSecond = this.options.isPartial && !this.isError ? Math.floor(Date.now() / 1000) : -1;
		if (this.cachedWidth === safeWidth && this.cachedTimeSecond === timeSecond && this.cachedLines) {
			return this.cachedLines;
		}
		const state = this.context.state;
		const now = state.endedAt ?? Date.now();
		const duration = state.startedAt === undefined ? undefined : formatDuration(now - state.startedAt);
		const status = this.isError
			? `Failed${duration ? ` · Took ${duration}` : ""}`
			: this.options.isPartial
				? `Running${duration ? ` · Elapsed ${duration}` : ""}`
				: `Done${duration ? ` · Took ${duration}` : ""}`;
		const statusColor = this.isError ? "error" : this.options.isPartial ? "warning" : "success";
		const lines = [truncateToWidth(this.theme.fg(statusColor, status), safeWidth, safeWidth > 1 ? "…" : "")];
		if (this.output) {
			const outputColor = this.isError ? "error" : "toolOutput";
			const styled = this.output
				.split("\n")
				.map((line) => this.theme.fg(outputColor, line))
				.join("\n");
			if (this.options.expanded) {
				lines.push(...fitLines(wrapTextWithAnsi(styled, safeWidth), safeWidth));
			} else {
				const preview = truncateToVisualLines(styled, RESULT_PREVIEW_LINES, safeWidth);
				if (preview.skippedCount > 0) {
					lines.push(...fitLines(expansionLabels(preview.skippedCount, "earlier"), safeWidth));
				}
				lines.push(...fitLines(preview.visualLines, safeWidth));
			}
		}
		this.cachedWidth = safeWidth;
		this.cachedTimeSecond = timeSecond;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedTimeSecond = undefined;
		this.cachedLines = undefined;
	}

	dispose(): void {
		clearTimingInterval(this.context.state);
	}
}

function reuseCallComponent(
	context: PowerShellRenderContext<unknown>,
	text: string,
	expanded: boolean,
): Component {
	const component =
		context.lastComponent instanceof PowerShellCallComponent
			? context.lastComponent
			: new PowerShellCallComponent();
	component.update(text, expanded);
	return component;
}

function beginTiming(context: PowerShellRenderContext<unknown>): void {
	if (context.executionStarted && context.state.startedAt === undefined) {
		context.state.startedAt = Date.now();
		context.state.endedAt = undefined;
	}
}

function clearTimingInterval(state: PowerShellRendererState): void {
	if (!state.interval) return;
	clearInterval(state.interval);
	state.interval = undefined;
}

function updateTiming(
	options: ToolRenderResultOptions,
	context: PowerShellRenderContext<unknown>,
): void {
	if (context.state.startedAt !== undefined && options.isPartial && !context.isError && !context.state.interval) {
		context.state.interval = setInterval(() => context.invalidate(), 1000);
		context.state.interval.unref?.();
	}
	if (!options.isPartial || context.isError) {
		context.state.endedAt ??= Date.now();
		clearTimingInterval(context.state);
	}
}

function renderSharedResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: PowerShellRenderContext<unknown>,
): Component {
	updateTiming(options, context);
	const component =
		context.lastComponent instanceof PowerShellResultComponent
			? context.lastComponent
			: new PowerShellResultComponent();
	component.update(result, options, theme, context);
	return component;
}

export function renderPwshCall(
	args: PwshRenderArgs,
	theme: Theme,
	context: PowerShellRenderContext<PwshRenderArgs>,
): Component {
	beginTiming(context as PowerShellRenderContext<unknown>);
	const command = asString(args?.command) ?? "...";
	const options: string[] = [];
	if (args?.run_in_background === true) options.push("background");
	const name = asString(args?.name);
	if (name) options.push(`name ${name}`);
	const timeout = asFiniteNumber(args?.timeout);
	if (timeout !== undefined) options.push(`timeout ${timeout}s`);
	const notify = asString(args?.notify_on);
	if (notify) options.push(`notify /${notify}/`);
	const summary = `${theme.fg("toolTitle", theme.bold("PS>"))} ${theme.fg("accent", command)}${
		options.length ? `\n${theme.fg("muted", options.join(" · "))}` : ""
	}`;
	return reuseCallComponent(context as PowerShellRenderContext<unknown>, summary, context.expanded);
}

export function renderPwshJobCall(
	args: PwshJobRenderArgs,
	theme: Theme,
	context: PowerShellRenderContext<PwshJobRenderArgs>,
): Component {
	beginTiming(context as PowerShellRenderContext<unknown>);
	const action = asString(args?.action) ?? "?";
	const parts = [theme.fg("toolTitle", theme.bold("job")), theme.fg("accent", action)];
	const id = asString(args?.id);
	if (id) parts.push(theme.fg("accent", id));
	const options: string[] = [];
	const lines = asFiniteNumber(args?.lines);
	if (action === "output" && lines !== undefined) options.push(lines === 0 ? "all buffered lines" : `${lines} lines`);
	const pattern = asString(args?.pattern);
	if (action === "wait" && pattern) options.push(`/${pattern}/`);
	const timeout = asFiniteNumber(args?.timeout);
	if (action === "wait" && timeout !== undefined) options.push(`${timeout}s`);
	const summary = `${parts.join(" ")}${options.length ? ` · ${theme.fg("muted", options.join(" · "))}` : ""}`;
	return reuseCallComponent(context as PowerShellRenderContext<unknown>, summary, context.expanded);
}

export function renderPowerShellResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: PowerShellRenderContext<unknown>,
): Component {
	return renderSharedResult(result, options, theme, context);
}

/** Test/debug helper that exposes only visible text, never model-facing values. */
export function renderVisible(component: Component, width: number): string[] {
	return component.render(width).map(stripTerminalSequences);
}
