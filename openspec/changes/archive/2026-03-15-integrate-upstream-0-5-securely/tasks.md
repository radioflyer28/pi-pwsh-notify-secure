# Tasks

## 1. Baseline and Development Tooling

- [x] 1.1 Create the implementation branch from `codex/security-hardening`, record `upstream/v0.5.0` as the comparison baseline, and verify `git log --left-right --cherry-pick` shows the expected secure and upstream commits without merging them.
- [x] 1.2 Add `tsconfig.json`, `typecheck` and `check` scripts, a reproducible lockfile, and development dependencies compatible with Pi/TUI 0.87.1 while preserving `private: true`, secure-fork metadata, and the `typebox` package; verify `npm ci` and `npm run typecheck` succeed.
- [x] 1.3 Adapt the upstream jiti-based integration harness alongside the existing security tests, separating Windows runtime tests from pure unit tests; verify the existing 11 security tests still pass before runtime behavior is changed.

## 2. Secure PowerShell Runtime

- [x] 2.1 Extend the executable-resolution boundary to return validated runtime metadata while accepting only trusted absolute PowerShell candidates and trusted absolute `taskkill.exe`; verify tests reject cwd lookalikes, empty/relative PATH entries, relative overrides, and unqualified discovery commands.
- [x] 2.2 Add a runtime module for version probing, fixed stdin bootstrap transport, generated status/cwd scripts, and process-tree termination without execution-policy overrides; verify argument-level tests contain no `-ExecutionPolicy Bypass` and transport tests execute long and nested-quote commands.
- [x] 2.3 Replace foreground encoded-command spawning with the secure stdin runtime, `StringDecoder` output handling, corrected native/cmdlet exit semantics, Pi `PI_*` environment injection, and cwd resolution inside the serialization queue; verify foreground echo, long-source, UTF-8, exit-code, environment, persistent-cwd, concurrent-cwd, timeout, abort, and no-output integration tests pass.
- [x] 2.4 Implement session-start runtime detection and graceful unavailable-runtime behavior while retaining PowerShell 7 preference and trusted Windows PowerShell fallback; verify active-tool tests leave Pi built-ins available when detection fails and remove both `bash` and `powershell` when detection succeeds.
- [x] 2.5 Route Pi `!` and `!!` through secure PowerShell operations only when runtime detection succeeds; verify user-shell integration tests exercise successful execution, timeout/abort cleanup, persistent cwd, and fallback propagation when no runtime is available.

## 3. Secure Notification Delivery

- [x] 3.1 Add a generic notification queue with bounded batch item/count limits, debounce, finite retries, cancellation by job and event kind, disposal, and drop reporting; verify deterministic unit tests cover successful batching, transient retry, permanent failure, cancellation, and disposal.
- [x] 3.2 Replace the inline notification timer with the queue while keeping `src/notifications.ts` as the only model-facing payload builder; verify tests assert automatic message content and renderer details contain no command, job output, matched line, or log path.
- [x] 3.3 Track terminal observation and cancel queued ready/finished events when explicit `pwsh_job output` or `wait` calls report the same state; verify wait-on-exit, output-after-exit, ready-observation, and killed-job tests produce no duplicate automatic messages.
- [x] 3.4 Bound simultaneous notification batches and preserve steering plus idle wake behavior through Pi's `sendMessage` options; verify multi-job tests enforce batch size/content bounds and session shutdown disposes pending retries without cross-session delivery.

## 4. Background Job Reliability

- [x] 4.1 Add absolute output offsets, bounded-buffer rollover accounting, settlement state, terminal-observed state, and per-stream UTF-8 decoders to background jobs; verify rollover, split-multibyte, CRLF normalization, final-decoder-flush, and concurrent-cursor tests pass.
- [x] 4.2 Use Pi's standard byte/line truncation utilities for foreground, output, and wait results, including bounded `lines: 0` behavior and explicit missed-output warnings; verify oversized-output tests remain within both limits and never disclose a full-output log path.
- [x] 4.3 Strengthen explicit kill, timeout, abort, signal reaping, and session shutdown so process-tree errors are surfaced during active operations and cleanup waits only for a bounded settlement interval; verify kill-success, injected kill-failure, timeout, shutdown, reload-cycle, and late-notification tests pass.
- [x] 4.4 Preserve the existing job list and viewer behavior with the expanded job state, updating fixtures as needed; verify navigation, width, linger, scrolling, live refresh, disposal, and two-press kill UI tests pass.
- [x] 4.5 Add a regression test proving foreground and background execution create no default complete-output temp logs or log-path disclosures; verify the test passes after large and sensitive-looking output.

## 5. Release Metadata and Documentation

- [x] 5.1 Update the package version to `0.5.0-secure.1`, retain secure repository/install/private metadata, and set peer ranges to the oldest API-compatible Pi/TUI version confirmed by the implementation; verify package metadata tests and `npm pack --dry-run` include only intended files and cannot publish accidentally.
- [x] 5.2 Update `README.md` and research documentation to describe adopted upstream 0.5.0 reliability features, Pi 0.87.1 verification, secure executable resolution, metadata-only notifications, no default complete logs, runtime fallback, and `!`/`!!` behavior; verify documented commands and version strings match `package.json` and source behavior.

## 6. Final Verification

- [x] 6.1 Run `npm run check` on Windows and verify the complete unit, security, runtime, lifecycle, notification, and UI suite passes with zero failures.
- [x] 6.2 Smoke-load the extension through Pi 0.87.1 and verify registration succeeds with `pi --list-models -e ./src/index.ts` and no startup errors.
- [x] 6.3 Manually exercise a foreground command, a background ready event, an explicit wait, a completed job, and session shutdown; verify command/output data appears only through explicit tool boundaries and no orphan process remains.
- [x] 6.4 Compare the final branch against both `v0.4.2-secure.2` and `upstream/v0.5.0`, and verify every adopted upstream behavior and every intentionally rejected security behavior is accounted for in tests or documentation.
