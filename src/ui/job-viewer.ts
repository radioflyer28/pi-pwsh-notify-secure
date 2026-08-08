/**
 * job-viewer.ts — Live output overlay for background jobs.
 *
 * Claude Code-style: Enter on a job row opens this centered overlay showing the
 * job's captured output with scrolling, auto-follow, and a two-press kill.
 * Hooks into job.watchers so new output re-renders the overlay in real time.
 */

import { type Component, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { BgJob } from "../index.js";

/** Base lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES = 6;
const MIN_VIEWPORT = 3;
/** Height ceiling shared by the overlay's maxHeight and the viewer's internal viewport cap. */
const VIEWPORT_HEIGHT_PCT = 70;
/** Max output characters rendered per frame (oldest tail wins). */
const MAX_RENDER_CHARS = 100_000;

export type Theme = {
	fg(color: string, text: string): string;
	bold?(text: string): string;
};

/** `45s` / `3m20s` — same compact duration format as the job list. */
export function formatJobElapsed(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m${s % 60}s`;
}

/** Human-readable status for a job, shared by the list and the viewer. */
export function jobStatusText(job: BgJob): string {
	if (job.running) return "running";
	if (job.timedOut) return "timeout (killed)";
	if (job.killedByTool) return "killed";
	return `exited ${job.exitCode}`;
}

export class JobViewer implements Component {
	private scrollOffset = 0;
	private autoScroll = true;
	private lastInnerW = 0;
	private closed = false;
	/** Two-press confirm guard for the kill key, so a stray key can't kill the job. */
	private killArmed = false;
	/** Hooked into job.watchers (fired on every output chunk and on exit). */
	private readonly onOutput = () => {
		if (!this.closed) this.tui.requestRender();
	};

	constructor(
		private tui: TUI,
		private job: BgJob,
		private theme: Theme,
		private done: (result: undefined) => void,
		/** Kill the job shown here. Omitted → read-only (no kill affordance). */
		private onKill?: () => void,
	) {
		job.watchers.add(this.onOutput);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.closed = true;
			this.done(undefined);
			return;
		}

		// Kill: first "x" arms, second confirms; any other key disarms. Only
		// offered while the job is still running.
		if (matchesKey(data, "x")) {
			if (this.job.running && this.onKill) {
				if (this.killArmed) {
					this.killArmed = false;
					this.onKill();
				} else {
					this.killArmed = true;
				}
				this.tui.requestRender();
			}
			return;
		}
		if (this.killArmed) this.killArmed = false;

		const totalLines = this.buildContentLines(this.lastInnerW).length;
		const viewportHeight = this.viewportHeight();
		const maxScroll = Math.max(0, totalLines - viewportHeight);

		if (matchesKey(data, "up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.autoScroll = this.scrollOffset >= maxScroll;
		} else if (matchesKey(data, "down")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
			this.autoScroll = this.scrollOffset >= maxScroll;
		} else if (matchesKey(data, "pageUp")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
			this.autoScroll = false;
		} else if (matchesKey(data, "pageDown")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
			this.autoScroll = this.scrollOffset >= maxScroll;
		} else if (matchesKey(data, "home")) {
			this.scrollOffset = 0;
			this.autoScroll = false;
		} else if (matchesKey(data, "end")) {
			this.scrollOffset = maxScroll;
			this.autoScroll = true;
		}
	}

	render(width: number): string[] {
		if (width < 6) return []; // too narrow for any meaningful rendering
		const th = this.theme;
		const innerW = width - 4; // border + padding
		this.lastInnerW = innerW;
		const lines: string[] = [];

		const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
		const row = (content: string) =>
			th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + th.fg("border", "│");

		// Header: status icon + label + command + right-aligned stats
		lines.push(th.fg("border", `╭${"─".repeat(width - 2)}╮`));
		const label = this.job.name ? `${this.job.id} (${this.job.name})` : this.job.id;
		const statusIcon = this.job.running
			? th.fg("accent", "●")
			: this.job.killedByTool
				? th.fg("dim", "■")
				: this.job.exitCode === 0
					? th.fg("success", "✓")
					: th.fg("error", "✗");
		const elapsed = formatJobElapsed((this.job.endedAt ?? Date.now()) - this.job.startedAt);
		lines.push(row(
			`${statusIcon} ${th.bold?.(label) ?? label}  ${th.fg("muted", this.job.command)} ${th.fg("dim", "·")} ${th.fg("dim", `${jobStatusText(this.job)} · ${elapsed}`)}`,
		));
		lines.push(row(th.fg("dim", "─".repeat(innerW))));

		// Content area — rebuilt every render (live output, no cache needed)
		const contentLines = this.buildContentLines(innerW);
		const viewportHeight = this.viewportHeight();
		const maxScroll = Math.max(0, contentLines.length - viewportHeight);
		if (this.autoScroll) this.scrollOffset = maxScroll;
		const visibleStart = Math.min(this.scrollOffset, maxScroll);
		const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);
		for (let i = 0; i < viewportHeight; i++) {
			lines.push(row(visible[i] ?? ""));
		}

		// Footer: actions on the left, navigation on the right
		lines.push(row(th.fg("dim", "─".repeat(innerW))));
		const actions: string[] = [];
		if (this.job.running && this.onKill) {
			actions.push(this.killArmed ? th.fg("error", "x again to KILL") : th.fg("dim", "x kill"));
		}
		const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn · Esc close");
		const scrollPct = contentLines.length <= viewportHeight
			? "100%"
			: `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
		const footerLeft = [th.fg("dim", `${contentLines.length} lines · ${scrollPct}`), ...actions].join(th.fg("dim", " · "));
		const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
		lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
		lines.push(th.fg("border", `╰${"─".repeat(width - 2)}╯`));

		return lines;
	}

	invalidate(): void {
		// No cached state to clear.
	}

	dispose(): void {
		this.closed = true;
		this.job.watchers.delete(this.onOutput);
	}

	// ---- Private ----

	private viewportHeight(): number {
		// Cap mirrors the overlay's maxHeight — otherwise the viewer would render
		// more lines than the overlay shows and clip the footer.
		const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
		return Math.max(MIN_VIEWPORT, maxRows - CHROME_LINES);
	}

	private buildContentLines(width: number): string[] {
		if (width <= 0) return [];
		const th = this.theme;
		// The live buffer is normalized on write, but keep the overlay safe when
		// rendering a legacy or externally-created job with Windows CRLF output.
		const out = this.job.output.replace(/\r\n?/g, "\n");
		if (!out.trim()) {
			return [th.fg("dim", "(no output yet)")];
		}
		const tail = out.length > MAX_RENDER_CHARS ? out.slice(out.length - MAX_RENDER_CHARS) : out;
		const raw = tail.split("\n");
		if (tail.length < out.length) {
			raw.unshift(th.fg("dim", `… ${out.length - tail.length} chars omitted (oldest output dropped)`));
		}
		return raw.map((l) => truncateToWidth(l, width));
	}
}
