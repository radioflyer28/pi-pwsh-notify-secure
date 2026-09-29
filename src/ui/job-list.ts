/**
 * job-list.ts — Claude Code-style background job list rendered below the editor.
 *
 * Shows each running/recently-finished background job as a navigable list.
 * Pressing → (or Tab) at an empty prompt activates the list; ↑/↓ move the
 * selection (filled ● marker), Enter opens the job's live output overlay,
 * Esc returns to the prompt.
 *
 * Mechanics (same pattern as pi-subagents' fleet view): the list is a
 * `belowEditor` widget (render-only), and ALL key handling goes through
 * `onTerminalInput` — which fires before the focused editor and can `consume`
 * keys — gated on `getEditorText() === ""` so normal typing is untouched.
 */

import { Editor, isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { BgJob } from "../index.js";
import { formatJobElapsed, jobStatusText, JobViewer, type Theme } from "./job-viewer.js";

/** Widget key for the below-editor job list. */
const JOBS_KEY = "pwsh-jobs";
/** Max job rows shown at once; extras collapse into a "↓ N more" indicator. */
const MAX_JOB_ROWS = 5;
/** Re-render cadence so elapsed/status tick while jobs run. */
const TICK_MS = 200;
/** How long a finished job lingers in the list before it drops out. */
const FINISHED_LINGER_MS = 4000;

/** Minimal UI surface the job list needs from `ctx.ui` (structural subset). */
export type JobListUICtx = {
	setWidget(
		key: string,
		content:
			| undefined
			| ((
					tui: any,
					theme: Theme,
			  ) => { render(width: number): string[]; invalidate(): void; dispose?(): void }),
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
	onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
	getEditorText(): string;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	custom<T>(
		factory: (
			tui: any,
			theme: Theme,
			keybindings: any,
			done: (result: T) => void,
		) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
		options?: { overlay?: boolean; overlayOptions?: unknown },
	): Promise<T>;
};

/**
 * Place `right` flush to `width`, truncating `left` first so the stats survive.
 * The final clamp guarantees the line never exceeds `width` (which would wrap and
 * desync pi's line-diff → flicker) even on a terminal too narrow for the stats.
 */
function rightAlign(left: string, right: string, width: number): string {
	const rightW = visibleWidth(right);
	const maxLeft = Math.max(0, width - rightW - 1);
	const leftClamped = truncateToWidth(left, maxLeft);
	const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
	return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

/** First line of the command, truncated — enough to recognize the job. */
function commandSummary(command: string, maxLen: number): string {
	const line = command.split("\n")[0] ?? "";
	return line.length <= maxLen ? line : line.slice(0, maxLen) + "…";
}

export class JobList {
	private ui: JobListUICtx | undefined;
	private tui: any | undefined;
	private inputUnsub: (() => void) | undefined;
	private widgetRegistered = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	/** Whether arrow keys currently navigate the list (vs. flow to the editor). */
	private active = false;
	/** Index into visibleJobs(). */
	private selectedIndex = 0;
	/** Set while a viewer overlay is open; calling it closes the overlay. */
	private viewerClose: (() => void) | undefined;
	private viewingJobId: string | undefined;

	constructor(
		private jobs: Map<string, BgJob>,
		/** Kill a job from the viewer (marks killedByTool + taskkill). */
		private onKill: (job: BgJob) => void,
	) {}

	/** Capture the UI context and (re)register the global input handler. */
	setUICtx(ui: JobListUICtx): void {
		if (ui === this.ui) return;
		this.inputUnsub?.();
		this.ui = ui;
		this.widgetRegistered = false;
		this.tui = undefined;
		this.inputUnsub = ui.onTerminalInput((data) => this.handleKey(data));
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.inputUnsub?.();
		this.inputUnsub = undefined;
		if (this.viewerClose) {
			this.viewerClose();
			this.viewerClose = undefined;
		}
		this.viewingJobId = undefined;
		if (this.ui && this.widgetRegistered) this.ui.setWidget(JOBS_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.active = false;
		// Null last so a `viewerClose()` microtask above can't re-register the widget.
		this.ui = undefined;
	}

	/** Re-register/refresh the below-editor widget; clears it when no jobs remain. */
	update(): void {
		if (!this.ui) return;
		const jobs = this.visibleJobs();

		if (jobs.length === 0) {
			if (this.widgetRegistered) {
				this.ui.setWidget(JOBS_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			if (this.timer) {
				clearInterval(this.timer);
				this.timer = undefined;
			}
			this.active = false;
			this.selectedIndex = 0;
			return;
		}

		this.clampSelection();
		if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);

		if (!this.widgetRegistered) {
			this.ui.setWidget(
				JOBS_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (w: number) => this.renderBar(w, theme),
						invalidate: () => {
							this.widgetRegistered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "belowEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	// ---- Roster ----

	/**
	 * Jobs shown in the list, ordered earliest-launched first. Included:
	 * running jobs, the job currently being viewed (stays visible even after it
	 * finishes), and recently-finished ones (they linger briefly).
	 */
	private visibleJobs(): BgJob[] {
		const now = Date.now();
		return [...this.jobs.values()]
			.filter(
				(j) =>
					j.running || Boolean(j.outcome?.cleanupError) ||
					j.id === this.viewingJobId ||
					(j.endedAt != null && now - j.endedAt < FINISHED_LINGER_MS),
			)
			.sort((a, b) => a.startedAt - b.startedAt);
	}

	private clampSelection(): void {
		const max = this.visibleJobs().length - 1;
		if (this.selectedIndex > max) this.selectedIndex = Math.max(0, max);
		if (this.selectedIndex < 0) this.selectedIndex = 0;
	}

	// ---- Key handling ----

	/** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
	handleKey(data: string): { consume?: boolean; data?: string } | undefined {
		if (!this.ui) return undefined;
		// Input listeners receive BOTH key-press and key-release (the kitty protocol
		// emits both, and matchesKey matches either) — act on press only.
		if (isKeyRelease(data)) return undefined;
		// While a viewer overlay is open, let it own all input.
		if (this.viewerClose) return undefined;
		// Input listeners fire BEFORE the focused component, and dialogs swap the
		// prompt editor out while getEditorText() still reads the detached — empty —
		// editor. So when anything but the editor owns the keyboard, stay out.
		if (!this.editorHasFocus()) {
			if (this.active) this.deactivate();
			return undefined;
		}

		if (!this.active) {
			// Activate: → or Tab at an empty prompt moves focus into the list.
			// (↓/← are deliberately NOT used: pi-subagents' fleet view claims those
			// keys, and pi's input listeners short-circuit on the first consume —
			// sharing an activation key would make one list unreachable when both
			// extensions have content.)
			const isActivator = matchesKey(data, "right") || matchesKey(data, "tab");
			if (isActivator && this.visibleJobs().length > 0 && this.ui.getEditorText() === "") {
				this.active = true;
				this.selectedIndex = 0;
				this.update();
				return { consume: true };
			}
			return undefined;
		}

		// Active — arrows navigate, Enter opens, Esc / Up-past-top exits.
		if (matchesKey(data, "down")) {
			const max = this.visibleJobs().length - 1;
			this.selectedIndex = Math.min(max, this.selectedIndex + 1);
			this.update();
			return { consume: true };
		}
		if (matchesKey(data, "up")) {
			if (this.selectedIndex === 0) {
				this.deactivate();
				return { consume: true };
			}
			this.selectedIndex -= 1;
			this.update();
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			this.deactivate();
			return { consume: true };
		}
		if (matchesKey(data, Key.enter)) {
			this.openSelected();
			return { consume: true };
		}

		// Any other key cancels navigation and flows to the editor.
		this.deactivate();
		return undefined;
	}

	/**
	 * True when pi's prompt editor owns the keyboard. pi's editor is an `Editor`
	 * subclass (CustomEditor) while every dialog/selector is not, so `instanceof`
	 * is a reliable identity check. Unknowable focus (no tui seen yet, nothing
	 * focused) counts as the editor so activation keeps working.
	 */
	private editorHasFocus(): boolean {
		const focused = (this.tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
		return focused == null || focused instanceof Editor;
	}

	private deactivate(): void {
		this.active = false;
		this.selectedIndex = 0;
		this.update();
	}

	private openSelected(): void {
		const job = this.visibleJobs()[this.selectedIndex];
		if (!job || !this.ui) return;
		this.viewingJobId = job.id;

		void this.ui
			.custom<undefined>(
				(tui, theme, _keybindings, done) => {
					this.viewerClose = () => done(undefined);
					return new JobViewer(tui, job, theme, done, () => this.onKill(job));
				},
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" },
				},
			)
			.then(() => this.clearViewer(), () => this.clearViewer());
	}

	/** Reset overlay state and return to the list (on close, auto-close, or error). */
	private clearViewer(): void {
		// Keep the cursor on the job we were viewing; if it dropped out of the
		// roster, update()'s clamp settles the index.
		if (this.viewingJobId) {
			const idx = this.visibleJobs().findIndex((j) => j.id === this.viewingJobId);
			if (idx >= 0) this.selectedIndex = idx;
		}
		this.viewerClose = undefined;
		this.viewingJobId = undefined;
		this.update();
	}

	// ---- Rendering ----

	private renderBar(width: number, theme: Theme): string[] {
		const jobs = this.visibleJobs();
		if (jobs.length === 0) return [];
		// Clamp locally so a render between a roster shrink and the next update()
		// (e.g. on terminal resize) never loses the selection marker.
		const sel = Math.min(this.selectedIndex, jobs.length);

		const hint = this.active
			? "↑↓ select · enter view · esc back"
			: "→ / Tab for jobs";
		const lines: string[] = [];
		lines.push(truncateToWidth("  " + theme.fg("dim", hint), width));
		lines.push("");

		// Window the job rows so the selected one stays visible.
		const visible = Math.min(MAX_JOB_ROWS, jobs.length);
		const selJob = Math.max(0, sel);
		const start = selJob < visible ? 0 : selJob - visible + 1;
		const hiddenBelow = jobs.length - (start + visible);

		if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
		for (let i = start; i < start + visible; i++) {
			lines.push(this.renderJobRow(i, sel, jobs[i], width, theme));
		}
		if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));

		return lines;
	}

	private renderJobRow(rowIndex: number, sel: number, job: BgJob, width: number, theme: Theme): string {
		const bullet = rowIndex === sel ? theme.fg("accent", "●") : theme.fg("dim", "○");
		const label = job.name ? `${job.id} (${job.name})` : job.id;
		const left = `  ${bullet} ${theme.fg("muted", label)}  ${commandSummary(job.command, 40)}`;
		const elapsed = formatJobElapsed((job.endedAt ?? Date.now()) - job.startedAt);
		const right = theme.fg("dim", `${jobStatusText(job)} · ${elapsed}`);
		return rightAlign(left, right, width);
	}
}
