# Upstream 0.6.0 secure adaptation

## Decision and scope

Review range: upstream `v0.5.0` (`4a7a48a03e3db3a6d7da901c5d0db1668560be85`) through `v0.6.0` (`cb5673b416e172d3410100f363e2b004d4725001`). Fork base: `f68102c74f919203a000db30180814c8a10baf29`, including the externally completed Pi 1.5 dependency-security upgrade.

Stay behaviorally aligned with upstream wherever policy permits. Adopt the resolver and inherited-pipe improvements; retain equivalent or stronger existing fork behavior. Do not wholesale replace the fork's execution, notification, result, or dependency modules. A `git merge-tree --write-tree --name-only HEAD v0.6.0` trial before this adaptation reported nine conflicts: `.gitignore`, `README.md`, `package-lock.json`, `package.json`, `src/index.ts`, `src/notification-queue.ts`, `src/runtime.ts`, `test/run-tests.mts`, and `tsconfig.json`. It did not start a merge or alter tracked files.

This is a selective semantic sync, not a merge/cherry-pick or an upstream ancestry claim. Advancing the reviewed drift baseline records that every incoming change was assessed, not that every upstream choice was copied. The package/install tag remains `v0.5.0-secure.7`; release and installation updates require separate approval.

## Commit accounting

| Upstream commit | Subject | Decision |
| --- | --- | --- |
| `c359fcd` | Harden executable resolution and job notifications | Adapt direct probing, full qualification, Store discovery, implicit UNC exclusion, and probe/cleanup cwd. Metadata-only notifications and random cwd tokens already exist. |
| `bfce8f7` | Support Pi 1.x | Already present: TypeBox migration, TUI-only input, session-scoped process hooks, and Pi 1.5 development pins. Adapt real-session regressions using the fork's version-isolated loader. |
| `b4565a7` | Stop inherited pipes from hanging commands and bound foreground memory | Most lifecycle/bounds already present. Adapt drain/detach/unref and poll-phase activity recheck; reject complete-log spill. |
| `be66de8` | Test non-ASCII output through PowerShell, native commands and jobs | Adapt the combined real-process Unicode regression. |
| `c36422e` | Rewrite the README around what users gain | Keep fork-specific documentation; do not import npm-install, complete-log, or unconditional no-orphans claims. |
| `cb5673b` | 0.6.0 | Record upstream reviewed version/hash, without relabeling an existing secure release. |

## Behavior and file accounting

| Incoming file/behavior | Status | Fork implementation or rationale |
| --- | --- | --- |
| `src/runtime.ts`: direct candidate probes | Adapted | `src/security.ts` no longer gates PowerShell probes on `existsSync()`. A Store App Execution Alias may launch despite a false existence result; probe failure remains authoritative. |
| Full drive/UNC validation | Adapted, stricter | Reject current-drive-rooted and drive-relative names, device namespaces, and incomplete UNC overrides. Explicit UNC needs both server and share. Automatic discovery admits drive-qualified paths, not UNC entries. This is name-resolution hardening, not binary authentication or proof that a drive/junction is physically local. |
| LOCALAPPDATA Store candidate | Adapted | Probe it before the fork's Windows PowerShell fallback; deduplicate against PATH. Preserve preference for machine-wide PowerShell 7. |
| Probe/taskkill cwd | Adapted | Use the executable's directory rather than the project directory; retain bounded synchronous probes and System32 cleanup. Do not adopt `-ExecutionPolicy Bypass`. |
| `src/index.ts`: metadata-only automatic content/details | Already present | `src/notifications.ts` and renderer details preserve the explicit output-read boundary, including escaping metadata. Upstream has now closed the original resolution/disclosure issues. |
| Private randomized cwd records | Already present | `src/execution.ts` uses per-execution UUIDs and incremental parsing independent of output retention. Keep its oversized-record parser bound. |
| Pi 1.x TUI/lifecycle changes | Already present | Hooks begin at session start and are idempotent/disposed; RPC/JSON/print do not own terminal input. Retain host-owned Pi 1.5 hints and legacy capability fallbacks. |
| New `src/capture.ts`: inherited-pipe lifecycle | Adapted, not duplicated | Keep the fork's shared `startExecution()` for foreground/background/user shell. Detach consumers, drain/discard open pipes, and unref sockets rather than destroying a surviving descendant's stdout/stderr. A new real descendant regression checks both output streams for broken-pipe errors. |
| Idle deadline activity recheck | Adapted | Give the event-loop poll phase a pass with `setImmediate`, then recheck activity before settlement. A deterministic boundary regression prevents queued output being lost. |
| Bounded UTF-8 output and late output | Already present | Independent decoders/CRLF state, surrogate-safe 400,000-code-unit tails, explicit incomplete-capture warnings, cwd parsing, and post-exit timeout/abort handling already exist. Keep truthful termination-request/capture-stop outcomes and stale-PID protection. |
| `src/logs.ts` and foreground spill in `src/index.ts` | Rejected | Preserve no default complete-output disk logs. Do not add the upstream log module or disclose log paths. Detached pipe draining neither retains nor logs discarded output. |
| `test/run-tests.mts` | Adapted | Add Store-alias conditional live coverage, resolver unit/runner regressions, descendant-survival and combined PowerShell/native/background Unicode coverage. Existing tests cover bounds, cwd, shutdown, notifications, timeout units, decoder boundaries and inherited handles. |
| New `test/real-session.mts` | Adapted without a parallel loader | Reuse `test/codemode.test.mts` host isolation and faux provider to prove idle wake-up excludes output until explicit read, and active-run completion steers without a competing turn. Existing real-session tests cover pruning and the newer custom-run lifecycle. |
| C# executable-lookalike test harness | Deferred test-only port | Do not add a compiler dependency to the compatibility matrix in this patch. Qualification, candidate filtering, no-launch guards, injected probe cwd/arguments, real runtime execution and cleanup remain covered. An optional native lookalike fixture could strengthen end-to-end lookup evidence later. |
| `package.json`, `package-lock.json` | Keep reviewed fork metadata/lock | Pi/TUI 1.5 pins are already present with patched Undici 8.12.3/minimatch 11.0.3. Preserve `private: true`, secure identity/install ref, peer floor `>=0.84.3`, bounded TypeBox peer range and the six-host matrix; reject upstream wildcard peers/npm publication metadata. |
| `README.md`, `README.zh-CN.md` | Retain fork documentation | Update reviewed baseline, resolver semantics, and detached-pipe behavior; do not import upstream marketing or install/logging claims that differ from this fork. |

## Verification evidence and limits

- `npm run check`: typecheck, **72 unit tests passed**, **59 integration tests passed**, one conditional Store-alias skip. New idle and active real-session tests and the actual descendant-survival test passed. These are model-free faux-provider tests, not paid model calls.
- Isolated pinned fixtures passed on Pi/TUI **0.84.3, 0.87.1, 0.99.1, 1.1.0, and 1.2.0**, with expected capability/Store skips.
- Unlocked fresh resolution for Pi 1.5 was blocked by the persistent seven-day npm release-age policy (`ETARGET`, cutoff 2026-10-26). No age exception was used. `npm run test:host -- --version 1.5.0 --lock package-lock.json` then passed in an isolated fixture using `npm ci` and the already-reviewed repository lock: **72 unit + 59 integration passed**, one Store skip. This is locked replay, not fresh registry resolution.
- Retained fixture evidence directories under `%TEMP%`: `pwsh-host-0.84.3-9cQjp9`, `pwsh-host-0.87.1-04GeIO`, `pwsh-host-0.99.1-nnJ4qE`, `pwsh-host-1.1.0-Nx9YBS`, `pwsh-host-1.2.0-1QB50A`, `pwsh-host-1.5.0-D6JWYA`.
- `test/manual-smoke.mts` was repaired to use Pi's public wrapper/error-result hooks and structured termination-request/observed-settlement semantics. Its real-process/component smoke passed, including metadata privacy, explicit waits, rendering bounds and orphan checking. This is not interactive visual certification.
- `npm audit` reported zero vulnerabilities; saved npm `min-release-age` is **7**. Package dry-run succeeded. The CLI load smoke must use `pi --no-extensions --list-models -e ./src/index.ts` to avoid loading the separately installed secure extension as a duplicate.
- Hosted compatibility is a separate gate: inspect the actual GitHub run for this branch/commit before claiming CI success. Local fixtures do not establish that result.
- No Store PowerShell alias is installed on this machine. Deterministic direct-probe coverage passed, but actual Store-alias launch certification remains conditional on a Store-equipped host.
- Regular/fullscreen visual smoke remains operator-deferred as recorded in `docs/maintenance/dependency-security.md`; no installed extension tag was changed.

## Future sync process

Keep `scripts/check-upstream.mts` pinned to the reviewed tag and full commit. Its existing weekly read-only workflow reports drift, not automatic merge permission. For every new release: enumerate commits and files, reassess a normal merge, port compatible improvements with regression tests, document intentional differences, run supported-host checks, and only then advance the reviewed baseline. Avoid cosmetic divergence and upstream-equivalent duplicate subsystems; keep fork policy isolated behind the existing security, execution, notification and result boundaries.
