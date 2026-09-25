# Design

## Context

See `proposal.md` for motivation. The current secure fork is based on upstream 0.4.2 and adds three non-negotiable controls: verified absolute executable resolution, no forced execution-policy bypass, and metadata-only autonomous notifications. Upstream 0.5.0 independently adds a stronger command transport, runtime validation, bounded output, job lifecycle fixes, retryable notifications, complete temporary logs, and a broad integration suite.

The upstream commit cannot be merged wholesale because its runtime again invokes unqualified executables, forces `-ExecutionPolicy Bypass`, injects command/output data into steering messages, writes complete logs by default, uses the legacy TypeBox package, and does not suppress Pi's native `powershell` tool. The adaptation therefore needs to be semantic rather than commit-level.

## Goals / Non-Goals

**Goals:**

- Reproduce the useful externally observable behavior of upstream 0.5.0 while retaining every secure-fork invariant.
- Separate executable trust, process transport, notification queuing, and tool orchestration into testable modules.
- Establish a repeatable compatibility and security test suite against Pi 0.87.1.
- Keep the package usable with PowerShell 7 preferred and the existing trusted Windows PowerShell fallback.

**Non-Goals:**

- Merging or cherry-picking upstream 0.5.0 as a whole.
- Sending command text or process output through automatic notifications.
- Writing complete output logs to disk by default.
- Adding persistent jobs across Pi session replacement or process restart.
- Publishing the secure fork to npm.

## Decisions

### 1. Selectively port behavior onto the secure branch

Implementation will start from `codex/security-hardening` and manually adapt upstream features. The upstream `main` branch remains a comparison source and tracking ref.

This avoids a conflict-heavy merge whose successful resolution could still silently reintroduce insecure defaults. Cherry-picking the single 0.5.0 commit was rejected for the same reason: nearly every runtime and notification section conflicts with the fork's security model.

### 2. Keep executable trust in a dedicated security boundary

`src/security.ts` remains the authority for Windows path parsing, PowerShell candidate enumeration, and absolute `taskkill.exe` resolution. A runtime module may probe versions, build scripts, spawn processes, and terminate trees, but it must receive or call trusted absolute paths from the security boundary.

Runtime probing and command execution will not include `-ExecutionPolicy Bypass`. The explicit executable override, if retained, must be absolute and pass the same existence and runtime probe checks rather than bypassing candidate validation.

Alternative considered: adopt upstream's `where.exe` probe and then validate its results. This was rejected because invoking `where.exe` itself creates an avoidable executable-resolution boundary and adds no capability that absolute PATH parsing cannot provide.

### 3. Replace encoded commands with a fixed stdin bootstrap

The launcher will start the trusted PowerShell executable with a small fixed bootstrap and send the generated script as BOM-less UTF-8 stdin. Script construction will retain the upstream status-capture approach so both native and PowerShell failures are represented correctly.

This removes Windows command-line length pressure and reduces quoting transformations. The bootstrap and generated script must be tested against both PowerShell 7 and the supported Windows PowerShell fallback. If concrete incompatibility is found, the fallback may require a compatibility branch within the launcher rather than being silently removed.

Alternative considered: retain `-EncodedCommand`. It remains safe for quoting but keeps a practical Windows command-line size ceiling and does not gain upstream's stdin robustness.

### 4. Use explicit runtime availability to control tool selection

Runtime detection will occur at session start and may be retried when a tool or user-shell command is invoked. When a runtime is available, the active-tool pruning helper removes both built-in `bash` and `powershell`; when unavailable, it removes `pwsh` and `pwsh_job` instead and leaves built-ins intact. Conditional search-tool pruning remains unchanged.

The `user_bash` event will return secure PowerShell operations only when runtime detection succeeds. This aligns `!` and `!!` with the model-facing shell without breaking fallback behavior.

### 5. Port rollover-safe job state without default disk logs

Jobs will gain an absolute `baseOffset`, absolute cursor, settlement state, and terminal-observed state. UTF-8 `StringDecoder` instances will flush before finalization. Foreground and job-tool results will use Pi's exported byte/line truncation helpers.

The upstream `LogStore` will not be ported in this change. Complete disk logs improve recovery after memory rollover, but they also create a new secret-retention surface and contradict the current explicit-output boundary. Rollover will instead be reported clearly. Optional secure logging can be proposed separately with opt-in configuration, permissions, retention, and threat analysis.

### 6. Port the notification queue while preserving safe payload construction

A generic queue module will provide debounce, item-count and character bounds, finite retries, cancellation by job/kind, disposal, and a drop callback. The queue receives already-sanitized metadata items; it must not know commands or output.

`src/notifications.ts` remains responsible for constructing escaped metadata-only content. TUI details remain limited to status display fields. Explicit output/wait calls will cancel matching queued events and set terminal observation state to prevent later duplicates.

Alternative considered: port upstream's richer notification renderer. Rejected because command and output inclusion expands prompt-injection exposure and bypasses the explicit `pwsh_job` trust boundary.

### 7. Adapt upstream tests rather than replace current tests

The test suite will combine:

- Existing package metadata, executable-resolution, execution-policy, notification-content, and tool-selection regression tests.
- Upstream real-PowerShell foreground/background, exit-code, transport, cwd, timeout, cursor, lifecycle, and UI tests.
- Queue-specific tests with deterministic short delays.
- New negative assertions that automatic messages and renderer details never contain command/output data and that no default log file is created.

Tests will load the extension through `jiti`, matching Pi's runtime behavior. Runtime integration tests are Windows-specific; pure unit/security tests remain runnable independently. Development dependencies will target Pi/TUI 0.87.1 while peer ranges remain at the oldest version actually supported by the resulting APIs, expected to stay `>=0.84.3` unless type-checking or runtime validation proves otherwise.

### 8. Release as a secure adaptation of upstream 0.5.0

Package version becomes `0.5.0-secure.1`. Repository, homepage, issue tracker, install command, `private: true`, and absence of `publishConfig` remain secure-fork values. Documentation will distinguish behavior adopted from upstream from controls intentionally retained or rejected.

## Risks / Trade-offs

- **[PowerShell 5.1 bootstrap incompatibility]** → Add launcher compatibility tests and isolate version-specific script behavior; do not remove fallback without an explicit follow-up decision.
- **[Increased orchestration complexity]** → Extract narrowly scoped runtime and queue modules and keep the extension entry point focused on state coordination.
- **[No recovery of output beyond the memory tail]** → Return explicit rollover warnings; defer complete logs until an opt-in secure design exists.
- **[Retry delivery creates delayed events]** → Bound attempts and delay, cancel observed events, and dispose the queue on shutdown.
- **[Tests depend on real Windows process timing]** → Use generous bounded timing assertions and keep deterministic queue/security unit tests separate from slower integration tests.
- **[Pi compatibility floor becomes inaccurate]** → Type-check and smoke-load against Pi 0.87.1 and verify all newly imported APIs existed at the declared minimum before retaining the peer range.

## Migration Plan

1. Create an integration branch from `codex/security-hardening` and record upstream tag `v0.5.0` as the comparison baseline.
2. Add development tooling and the adapted test harness without changing runtime behavior.
3. Introduce the notification queue behind existing metadata-only message construction.
4. Introduce secure runtime helpers and stdin transport while preserving absolute resolution and no-bypass tests.
5. Port job-state, output-bound, observation, and shutdown changes incrementally with tests after each group.
6. Add user-shell routing and runtime-aware tool selection.
7. Update package metadata and documentation for `0.5.0-secure.1`.
8. Run type-checking, the complete test suite, Pi extension smoke loading, and package metadata checks before tagging.

Rollback consists of returning to tag `v0.4.2-secure.2`; no session file migration or external data migration is required because jobs remain session-scoped and no new persistent storage is introduced.
