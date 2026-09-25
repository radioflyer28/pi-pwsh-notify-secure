# Design

## Context

See `proposal.md` for motivation and `screenshot.png` for the observed generic rendering. Both model-facing tools registered by the package, `pwsh` and `pwsh_job`, currently omit `renderCall` and `renderResult`, so Pi uses the generic fallback. Pi 0.87.1 already exposes the required extension contracts: render-call and render-result slots, an `expanded` flag controlled by `app.tools.expand` (`Ctrl-O` by default), renderer-local state, reusable previous components, invalidation callbacks, `keyHint`, `truncateToVisualLines`, and TUI width utilities.

Pi's built-in shell renderer provides the target interaction pattern: a command header remains visible, collapsed results show a bounded tail, omitted content includes the configured expansion hint, expanded results show all available text, and duration updates while streaming. This package needs an analogous presentation adapted to its additional background parameters and `pwsh_job` action schema.

## Goals / Non-Goals

**Goals:**

- Give `pwsh` and `pwsh_job` a coherent visual language within Pi's default tool shell.
- Keep enough invocation context visible to understand every collapsed block.
- Match Pi's global tool expansion semantics and configured keybinding hints.
- Keep rendering stable under streaming updates, theme changes, and terminal resize.
- Enforce a one-way presentation boundary: renderers may read tool calls/results but never mutate or replace the data retained for model context.
- Make renderer behavior independently testable from process execution.

**Non-Goals:**

- Changing the job list widget, live-output overlay, or background-notification renderer.
- Changing model-visible tool descriptions, parameters, result content, or execution behavior.
- Introducing a package-specific expansion key or handling `Ctrl-O` directly.
- Recovering command output that execution already truncated or discarded.
- Copying Pi's private renderer modules or importing unsupported internal subpaths.

## Decisions

### 1. Implement a shared public-API renderer module

Create a focused module under `src/ui/` that exports renderer functions for `pwsh` and `pwsh_job`. The tool definitions in `src/index.ts` will attach those functions through `renderCall` and `renderResult` while retaining Pi's default tool shell.

The module will use only package-root public exports from `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, including `keyHint`, `truncateToVisualLines`, `Container`, `Text`, `truncateToWidth`, and visible-width helpers. It will not import `dist/core/tools/renderers/bash.js` or another internal path even though the built-in renderer is the behavioral reference.

Alternative considered: duplicate the built-in shell renderer inline in `src/index.ts`. Rejected because it would further enlarge the extension entry point and make visual behavior difficult to test in isolation.

### 2. Use Pi's default tool shell

The tools will not set `renderShell: "self"`. Pi's default shell already supplies consistent padding, background, partial/success/error state, and global expansion integration. The custom renderers only own the call and result slot contents.

Alternative considered: self-render the entire block for maximum visual control. Rejected because it would duplicate Pi's framing behavior and increase the risk of visual drift across Pi releases.

### 3. Render invocation summaries per tool

`pwsh` call rendering will use a `PS>` prefix and include:

- command source;
- background marker when `run_in_background` is true;
- optional job name;
- optional timeout;
- optional `notify_on` marker or concise pattern summary.

In collapsed mode the command preview will preserve the first visual lines because the beginning usually identifies the operation. In expanded mode it will display the complete command and complete option summary.

`pwsh_job` call rendering will use a compact action-oriented summary, for example:

- `job list`
- `job output bg-1 · 100 lines`
- `job wait bg-1 · /ready|listening/ · 120s`
- `job kill bg-1`

Long patterns and ids will be width-bounded in collapsed mode and complete in expanded mode. Missing or malformed arguments will render defensively rather than throwing.

### 4. Show result tails when collapsed and all available text when expanded

A reusable result component will style textual content as tool output. Collapsed rendering uses a small visual-line tail, initially aligned with Pi's built-in shell preview of five lines. Visual-line truncation is width-aware, so wrapped command output counts against the preview consistently.

If content is omitted, the component inserts an ANSI-safe line such as `... (N earlier lines, Ctrl-O to expand)` using `keyHint("app.tools.expand", "to expand")`. Expanded mode displays all textual content present in the result with no renderer-specific line cap.

The tail is chosen for results because recent shell output normally contains the status, failure, or final answer. Invocation previews use the head because the start of a command identifies what ran.

### 5. Reuse components and renderer state during streaming

The renderer will reuse `context.lastComponent` where practical and store only row-local timing/cache state in `context.state`. On partial results it will start a one-second invalidation interval for elapsed time, clear it on completion/error, and rebuild preview caches when width, content, expansion state, or theme changes.

The command header and output preview remain separate slots, preventing partial result updates from replacing the invocation. Component disposal or completion must clear timers so reloads and settled transcript rows retain no active interval.

### 6. Enforce a one-way presentation boundary

The renderers will be pure presentation adapters over the arguments and results Pi passes to `renderCall` and `renderResult`. They may derive ephemeral strings, visual lines, timing state, and TUI components, but they will not mutate input objects, replace result content/details, append UI hints to stored messages, wrap `execute`, or alter the tool schema/description exposed to the model. Collapsed and expanded state exists only in renderer context and component state; it never becomes conversation data.

This separate change will not add UI-only data to model-facing result text or force a result-details migration. The renderer will read `context.isError`, `options.isPartial`, invocation arguments, and existing textual result content. Timeout, abort, exit code, wait outcome, and job status are already represented in returned text and remain visible. Renderer tests will deep-freeze representative arguments/results, render both modes, and verify that the values and their model-visible serialization remain unchanged.

If the upstream-integration change later introduces structured safe details, the renderer may read them as an optimization, but it must still preserve them exactly and this proposal does not depend on that ordering. This keeps the two OpenSpec changes independently applicable.

### 7. Test components at widths and expansion states

Renderer tests will instantiate the call/result functions with mock theme and context objects. Assertions will cover:

- command and action visibility;
- head truncation for invocation and tail truncation for output;
- configured expansion hints;
- collapsed versus expanded content;
- partial updates and timer cleanup;
- immutable call/result inputs and unchanged model-visible serialization before and after rendering or expansion;
- error styling and status retention;
- ANSI and wide-character width limits;
- defensive behavior for incomplete streaming arguments.

At least one integration-style test will register the extension and assert that both tools expose renderer slots. Visual snapshot images are optional; string/width assertions are the acceptance gate.

## Risks / Trade-offs

- **[Renderer behavior drifts from Pi's built-in shell renderer]** → Follow public renderer contracts and test the expected UX rather than copying private implementation imports.
- **[Long commands still consume too much expanded transcript space]** → Keep collapsed command previews small; expanded mode intentionally shows full available invocation because the user requested inspection.
- **[Global Ctrl-O expands every tool, not just the selected block]** → Accept Pi's standard behavior; do not implement a conflicting local focus model.
- **[Timing intervals leak after completion or reload]** → Clear intervals when partial rendering ends and test disposal/completion paths.
- **[Text parsing misclassifies success or failure]** → Rely primarily on `context.isError` and preserve raw status text rather than hiding it behind inferred summaries.
- **[Renderer code accidentally mutates model-visible data]** → Treat inputs as read-only, deep-freeze fixtures, and compare model-visible projections before and after collapsed, expanded, and streaming renders.
- **[Two proposals touch the same tool definitions]** → Keep renderer code extracted and attach it with small definition-level edits so it can be rebased cleanly onto the upstream-integration work.

## Migration Plan

1. Implement and test the renderer module independently using synthetic tool calls and results.
2. Attach custom renderers to `pwsh` and verify existing execution tests remain unchanged.
3. Attach custom renderers to `pwsh_job` and verify every action has an invocation summary.
4. Smoke-test collapsed, streaming, completed, failed, and expanded blocks in Pi 0.87.1 using the configured `app.tools.expand` action.
5. Document the new display behavior and optionally replace `screenshot.png` with paired collapsed/expanded examples.

Rollback removes the renderer attachments and module, returning both tools to Pi's generic fallback without changing stored tool results or execution behavior.
