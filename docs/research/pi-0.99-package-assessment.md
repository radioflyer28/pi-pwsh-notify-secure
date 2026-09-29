# Pi 0.99: package update assessment

Assessment date: 2026-09-29. Package examined: `v0.5.0-secure.5` (`648f47c`), on `dev`. Installed Pi changed externally from 0.87.1 to 0.99.1 during this assessment; this assistant did not upgrade it.

## Implementation follow-up (unreleased)

The approved second review supersedes the roadmap below where it differs:

- Kept the >=0.84.3 peer floor, default direct exposure, conservative missing annotation defaults, existing semantic theme APIs, and legacy thrown-error/result-hook bridge. Native `isError` migration and namespace decoration remain deferred, not unfinished requirements.
- Added discriminated structured results for foreground execution, background launch, list, output, wait, and stop. Pi 0.99 receives schema-backed error data through the existing error hook; earlier hosts retain their failure semantics. The hook does not restore data when an earlier redaction handler changed the error text.
- Text and machine output share one bounded snapshot and one cursor consumption. Process output excludes synthetic diagnostics; loss counters distinguish UTF-16 buffer eviction from result omission. JSON escaping is bounded too; no increased retention or disk output path was added.
- Shared job-status projection now prioritizes cleanup/spawn failures, distinguishes requested termination from stopped capture, and keeps failed-cleanup jobs visible for retry. Tool output, notifications, list, and viewer use it.
- Updated the protocol test mock for all three wrapper contracts, including the floor's `getActiveTools()` lookup. Added a positive wrapper-contract sentinel test.
- Added pinned Windows CI targets and an isolated test runner with saved fixture locks for exact dependency replay. Pi bundles its own TUI: tests must share that physical registry rather than a second independently installed TUI copy.
- Added real AgentSession/QuickJS tests using a local faux provider (no model network calls): structured failures, blocked execution, redaction in either hook order, timeout/cleanup failure, cancellation, unawaited foreground cleanup, background survival, cwd serialization, cursor consumption/replay, and exposure gating. Actual result objects are schema-checked. Theme tests exercise dark/light/system palettes where available, cached-vs-fresh render equivalence and narrow widths; these are component tests, not a manual terminal visual review.
- README documents the result contract, consumer-owned persistence, release-age policy, and testing/replay commands. New APIs are explicitly marked unreleased; the existing tag and install instructions remain unchanged.

### Verification of the implementation

On Windows, Node 24.13.0:

| Host | Typecheck | Unit tests | Integration tests | Installation evidence |
| --- | --- | --- | --- | --- |
| Pi/TUI 0.84.3 | passed | 59/59 | 40/40; 10 codemode tests intentionally skipped | Isolated exact-version npm fixture |
| Pi/TUI 0.87.1 | passed | 59/59 | 40/40; 10 codemode tests intentionally skipped | Isolated exact-version npm fixture |
| Pi/TUI 0.99.1 | passed | 59/59 | 50/50 including real codemode | Existing installed host, isolated source copy, plus current-checkout `npm run check` |

The final implementation source hashes match both older-host fixture copies; later renderer assertions were rerun against both. Full output/package dry-run includes the new result/status modules; `git diff --check` passes. Workflow YAML parses and its read-only permissions/version matrix were checked. The new GitHub workflow has **not** been dispatched, and a fresh npm install of 0.99.1 remains subject to the unchanged local seven-day release-age policy. The checked-in development dependency pins and lockfile were not upgraded; the test runner explicitly verifies the runtime host versions rather than treating those pins as runtime evidence.

Local fixture artifacts (temporary, not distributed): `pwsh-host-0.84.3-7YxcjJ`, `pwsh-host-0.87.1-RtOlbb`, and `pwsh-host-0.99.1-kjkVIN` under the system TEMP directory. CI saves fixture locks and evidence for replay. No package release, Git push, or installation update was performed.

## Original assessment

### Summary

Pi 0.99 adds useful extension APIs rather than replacing this package's managed PowerShell execution. Recommend a focused codemode/structured-result update, with compatibility tests before a new tag. Do not adopt native output-file persistence or weaken executable resolution.

The changelog already lists 0.99.1, a model-catalog/default-model patch. Review below uses pinned **0.99.0** docs/source for the new APIs. Initial isolated installation of **0.99.1** was prevented by this system's seven-day npm minimum-release-age setting; that safeguard was not overridden. Once an externally updated Pi 0.99.1 installation appeared, a temporary tracked-HEAD copy used junctions to its already-installed Pi/TUI libraries for compatibility checks, without downloading dependencies.

## Recommended changes

### 0. Update the test runner mock (necessary for the existing suite on 0.99)

Pi 0.99's public `wrapRegisteredTool()` calls `runner.createToolContext(toolCallId, signal)` instead of `runner.createContext()`. Our protocol harness in `test/run-tests.mts` mocks only the older method and casts to `any`, so typecheck misses this contract change. Four integration tests failed before reaching the actual command execution because the mock lacks `createToolContext`.

Provide both methods when maintaining old-host tests, or use a real runner/tool-context factory. Only the temporary test copy was adapted for this assessment; the repo test remains unchanged. This is a test infrastructure update, not evidence that the installed extension's command runner is broken.

Source: `wrapRegisteredTool` in the installed Pi 0.99.1 `dist/core/extensions/wrapper.js`; [pinned wrapper source](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/src/core/extensions/wrapper.ts).

### 1. Structured results for codemode (high value)

Declare `outputSchema` and return matching `structuredContent` for `pwsh` and `pwsh_job`. Pi's scripts otherwise receive a single text string, including human-oriented placeholders/status prose. Scripts should not have to parse a job id, exit code, or wait outcome out of text.

Suggested result design:

- Foreground: bounded `output`, nullable `exit_code`, elapsed time, `timed_out`, `aborted`, truncation/omitted-output metadata, output-capture incompleteness, cwd, and explicit cleanup/spawn errors.
- Background launch: a distinct result kind with `job_id`, state and PID if known.
- Job output/wait: `job_id`, state, `wait_outcome`, bounded output, missed-output indication and execution metadata.
- List/kill: matching structured entries/action outcomes rather than prose-only results.

Keep human/model-facing `content` concise. Do not duplicate command source into result metadata unnecessarily. Keep process output out of automatic notifications. Use empty strings for truly empty machine output rather than `(no output)`.

Pi's built-in shells now provide up to 1 MiB of script-facing output, recovering it through their output accumulator/temp file. **Do not copy that disk-backed design.** Our existing bounded retained tail can supply separately byte-bounded structured output, with explicit loss information and no `full_output_path`. A larger head-and-tail buffer is an optional separate retention-policy decision, not a compatibility requirement.

Sources: [extension result contract](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/docs/extensions.md#tools), [codemode behavior](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/docs/cli.md#how-codemode-works), [native shell schema/execution](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/src/core/tools/bash.ts).

### 2. Native error results instead of the throw/result-hook bridge (high value)

0.99 supports returning `{ content, details, structuredContent, isError: true }`. Our current foreground path throws bounded output and later attaches execution metadata through `tool_result` and a per-call map. On 0.99, normal execution failures can return their metadata directly. Keep throws for invalid input/unexpected failures as appropriate.

Codemode distinguishes failure forms: an error carrying schema-backed structured data can resolve to that data; an ordinary thrown/blocked/invalid call rejects with an Error. Tests should cover both, so scripts can branch on a nonzero command result without accidentally treating it as success or losing diagnostics.

This API is new. Before removing the old bridge, choose explicitly between:

- a release requiring Pi/TUI >=0.99.0; or
- an explicitly tested legacy path retaining the >=0.84.3 floor.

Do not simply return `isError` and assume older hosts will honor it.

Sources: [extension docs](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/docs/extensions.md#tools), [codemode tool contract](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/src/extensions/codemode/tool.ts).

### 3. Real nested-call and exposure tests (high value)

Add tests through `ctx.executeTool()`/codemode, not only our direct execute/protocol harness:

- foreground success/nonzero exit, timeout, cancellation and cleanup failure;
- background launch, readiness, wait/output cursor consumption and kill;
- nested ids (`parent/n`), permissions hooks and result-hook redaction;
- concurrency preserves the shared cwd queue;
- returned structured output and codemode's own printed output do not leak into automatic steering notifications;
- unavailable runtime removes callable extension tools, and active secure runtime removes native shell alternatives.

Keep default **direct** exposure. Existing direct tools are callable while active, so ordinary use does not require switching exposure to `codemode`. Pi's `codemode`/`deferred` exposures stay callable even when removed from `getActiveTools()`; changing exposure without rewriting runtime-failure gating would undermine the current availability model. Explicitly test that a user enabling codemode does not restore competing shells.

Sources: [exposure and nested-call docs](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/docs/extensions.md#tool-exposure), [public context/types](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/src/core/extensions/types.ts), package `src/tool-selection.ts`.

### 4. Compatibility matrix, themes and documentation (recommended)

- Add Pi/TUI 0.99.1 as a development/CI target once npm permits installation. Retain an older-host job only if backward compatibility is intentionally maintained.
- Existing metadata tests pin the development versions to 0.87.1; update them deliberately when the target changes. Those assertions are not runtime compatibility checks.
- Test tool rows, job lists, viewer overlays and notifications across `system`, dark/light, appearance changes and narrow widths. Our semantic `theme.fg()` calls are still supported; adopting `theme.style()` is optional, not a mandatory rewrite.
- Retain width/content caches and test invalidation on palette changes. Pi's own collapsed bash cache is now improved, but that does not remove our cache's value.
- Update README development/smoke target and add codemode examples. Clarify that codemode's output consumer can also persist oversized printed script output to disk, just as Pi owns the `!`/`!!` consumer. Our no-log promise is limited to our runner/tool implementation, not every host consumer.

Sources: [0.99 TUI](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/docs/tui.md), [system theme](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/docs/themes.md), [codemode output options](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/docs/cli.md#how-codemode-works), package `tests/package-metadata.test.ts`.

### 5. Namespace and conservative permission hints (optional)

Group both tools under one PowerShell namespace. Explicit hints can support permission integrations, but arbitrary commands are not read-only/idempotent and may be destructive/open-world. `pwsh_job` combines inspection and kill in one tool, and output consumption changes its cursor. Do not mark the whole tool harmless on the strength of its read-oriented actions. Pi's missing-hint defaults are already conservative, so explicit hints are useful documentation, not a new security boundary.

Source: [Tool annotations and namespaces](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/docs/extensions.md#tool-exposure).

## What does not need replacing

- Absolute candidate resolution and fixed UTF-8 stdin command transport.
- Bounded in-memory output and independent cwd-control parsing.
- Managed jobs, explicit wait/output/kill, cancellation and post-exit pipe handling.
- Metadata-only ready/finished steering batches.
- Our cached display-only renderers and configurable expansion binding.
- Runtime-aware shell pruning and PowerShell routing of user-shell commands.

Native 0.99 still discovers PowerShell through unqualified `where`, requests `ExecutionPolicy Bypass`, and supplies no managed job API in its shell schema. Native cleanup already uses a System32 `taskkill` path (as in our 0.87.1 review); that is not a new advantage unique to this fork.

Source: [pinned native shell helpers](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/src/utils/shell.ts).

## Package installation changes

Pi 0.99 suppresses automatic host peer installs for managed git packages. Our manifest already puts Pi/TUI/TypeBox in `peerDependencies`, with Pi/TUI development pins. Keep that separation and `private: true`. Official docs suggest `*` peer ranges, but that is not reason to remove an honest minimum supported version.

Sources: [release](https://github.com/earendil-works/pi/releases/tag/v0.99.0), [package dependency guidance](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/docs/packages.md#declare-dependencies).

## Additional existing inconsistency found

`src/ui/job-viewer.ts:jobStatusText()` still uses older status strings (`timeout (killed)`, `killed`) and does not inspect structured spawn/cleanup failures. `src/index.ts:statusOf()` has the newer stopped/cleanup-failed semantics. Consolidate these status projections and add list/viewer tests so a cleanup failure cannot be presented as a confirmed kill. This is an existing package follow-up, not a Pi 0.99 breaking change.

## Verification status and next step

Read the official changelog, pinned release docs and relevant source. Created a temporary copy of tracked HEAD and attempted installation of Pi/TUI 0.99.1 there with scripts disabled. npm refused the new release under `min-release-age=7`. The subsequently available, externally updated system Pi/TUI 0.99.1 libraries were used through temporary directory junctions; TypeScript, Jiti and TypeBox came from the unchanged repo dependency installation. The copied manifest remained pinned to its existing 0.87.1 development versions, so manifest checks alone do not certify actual library versions.

Initial results: typecheck passed, **53/53 unit tests passed**, and **35/39 integration tests passed**. The four failures originated from the obsolete runner-context mock described above. The temporary harness was then adapted to provide `createToolContext`, with no extension source change; **typecheck and all 39/39 integration tests then passed** against the installed Pi/TUI 0.99.1 libraries, including real PowerShell output/pipe/protocol stress cases.

The repo package source/lockfile, configured Pi package tag and npm age policy were not changed. Only this research note was added in the repository. No live model-provider/codemode execution or interactive system-theme verification is claimed by these tests.

Next: update the repo harness and add actual nested-call/codemode coverage. Then implement structured results/error returns with an explicit supported-host decision and publish a new immutable secure tag. No code release or installation update is part of this assessment.

Primary changelog: <https://pi.dev/changelog> (also includes 0.99.1). Pinned 0.99.0 release: <https://github.com/earendil-works/pi/releases/tag/v0.99.0>.
