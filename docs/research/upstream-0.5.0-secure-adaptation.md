# Upstream 0.5.0 secure adaptation matrix

Comparison baseline: upstream tag `v0.5.0` (`4a7a48a`)
Secure baseline: `v0.4.2-secure.2` (`8bf943f`)
Target release: `0.5.0-secure.1`

This release is a semantic adaptation, not a merge or cherry-pick. The matrix accounts for upstream 0.5.0 behavior against the fork's security requirements.

## Adopted behavior

| Upstream behavior | Secure adaptation | Evidence |
|---|---|---|
| Fixed bootstrap with UTF-8 stdin command transport | Adopted with only validated absolute PowerShell executables and no policy override | `src/runtime.ts`; long-source and nested-quote integration tests |
| PowerShell runtime probing | Adopted for PowerShell 7 and the trusted Windows PowerShell fallback | `src/security.ts`; runtime selection/fallback tests |
| Correct final native/cmdlet exit semantics | Adopted | `buildPowerShellScript`; native failure, cmdlet failure, and recovery tests |
| Streaming UTF-8 decoding and CR normalization | Adopted for foreground and each background stream | `StringDecoder` use in `src/index.ts`; split-multibyte/CRLF tests |
| Serialized cwd persistence | Adopted with cwd resolution after each foreground call reaches the queue | concurrent cwd integration test |
| Pi `PI_*` environment injection | Adopted | foreground environment integration test |
| Pi `!`/`!!` PowerShell routing | Adopted only while a trusted runtime is available; otherwise Pi fallback remains | user-shell success, cleanup, cwd, and unavailable-runtime tests |
| Runtime-aware tool availability | Adopted while continuing to remove both built-in `bash` and `powershell` when active | `src/tool-selection.ts`; active/unavailable tool tests |
| Retryable/cancellable notification queue | Adopted with bounded items/characters, finite retries, drop reporting, and shutdown disposal | `src/notification-queue.ts`; queue and multi-job lifecycle tests |
| Terminal observation suppression | Adopted for ready and finished events observed through explicit output/wait operations | notification observation integration tests |
| Absolute cursor and rollover accounting | Adopted for the bounded in-memory tail | `baseOffset`/absolute cursor implementation; rollover/concurrency tests |
| Pi-standard byte/line result bounds | Adopted for foreground, output, wait, and `lines: 0` | bounded-result integration tests |
| Stronger process lifecycle and settlement | Adopted with trusted absolute process-tree cleanup, surfaced active-operation errors, and bounded shutdown wait | kill, timeout/abort, shutdown, reload, and orphan checks |
| Existing job list/viewer test coverage | Adopted and expanded for the new job state | `tests/ui.test.ts` |
| Broad jiti/real-PowerShell integration harness | Adopted alongside pure unit/security/UI tests | `test/run-tests.mts`, `tests/*.test.ts` |

## Intentionally rejected or replaced behavior

| Upstream behavior | Secure decision | Evidence |
|---|---|---|
| Unqualified `where.exe`, `pwsh.exe`, or `powershell.exe` discovery | Rejected; enumerate only absolute candidates and validate by probing | `src/security.ts`; cwd-lookalike, relative PATH/override, and candidate tests |
| Unqualified `taskkill.exe` | Rejected; resolve the absolute executable beneath the trusted Windows system directory | `taskkillExecutable`; resolution and injected-failure tests |
| `-ExecutionPolicy Bypass` | Rejected for probes and command launches | runtime argument tests and source assertions |
| Command source, matched lines, or process output in automatic notifications | Rejected; automatic model content is constructed only by the metadata builder | `src/notifications.ts`; adversarial output and ready-match tests |
| Command/output data in notification renderer details | Rejected; details contain job id, optional label, status, outcome tone, and duration only | metadata-only renderer-detail integration test |
| Complete foreground/background temporary logs and disclosed paths | Rejected by default because they create a secret-retention surface | no-log regression test; no log module in `src/`; README security notes |
| `@sinclair/typebox` | Rejected; retain the fork's `typebox` dependency/import | package metadata test |
| Leaving Pi's native `powershell` model tool active | Rejected while the secure runtime is active; both built-in shells are removed | active-tool tests |
| Publishable upstream npm metadata | Rejected; retain `private: true`, secure repository/install metadata, and no `publishConfig` | package metadata tests and `npm pack --dry-run` |

## Compatibility and verification

- Pi/TUI 0.84.3 remains the peer floor after a clean type-check against both 0.84.3 packages.
- Pi/TUI 0.87.1 is pinned for development and is the extension smoke-load target.
- `npm run check` covers TypeScript, pure unit/security/UI tests, and real Windows PowerShell integration tests.
- `test/manual-smoke.mts` exercises foreground output, automatic metadata-only ready/finished events, explicit waits, completed state, session shutdown, and orphan detection.
