# Shared PowerShell execution hardening

Scope: the implementation released as `v0.5.0-secure.5`; it supersedes the pre-release validation notes captured on the `dev` branch.

## Implementation map

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Bound foreground/user-shell memory | `src/execution.ts`: `OutputTail`; 400,000 UTF-16 code units per capture, with surrogate-safe eviction | Synthetic sustained Unicode feed; real 32 MiB foreground and 16 MiB user-shell runs |
| Preserve cwd independently of output | Per-execution random control marker; incremental, bounded stdout parser | Split marker and rollover unit test; cwd persistence after noisy output; no marker in partial/final output |
| Coalesce previews and flush final state | `outputUpdates`: 100ms cadence plus final dirty flush | 10,000 updates coalesced in unit test; real noisy foreground preview counts and final-tail assertion |
| Stream user-shell output | `BashOperations.onData` receives decoded chunks immediately, not one completion buffer | Early output arrives at least 300ms before command completion; 16 MiB forwarded incrementally |
| Settle inherited pipes | Separate parent exit from EOF; 250ms idle grace reset on every arriving chunk | Fake and real quiet/actively-writing descendants; foreground, background and user-shell paths |
| Keep cancellation/deadlines effective after exit | Execution deadline and abort handler remain active during output draining | Continuous post-exit writer interrupted by timeout, abort and explicit stop; no stale-parent PID kill |
| Report protocol failures | Throw bounded retained output; `tool_result` hook attaches execution metadata | Pi public `wrapRegisteredTool`, plus an AgentSession-contract harness, checks `isError`, exit code, abort/timeout and cleanup diagnostics |
| Validate timeouts consistently | Central seconds-to-milliseconds conversion, before launch/wait | Negative, nonfinite and overflow values rejected; zero unlimited; fractions and maximum covered |
| Reduce behavioral drift | One runner for foreground, background and user-shell execution; shared foreground/cwd queue | Existing background notification/cursor/lifecycle suite; user-shell and model-call queue interoperability |

`tests/execution.test.ts` covers the runner primitives. `test/run-tests.mts` exercises real Windows PowerShell processes and the extension boundary. The protocol harness uses Pi's real public tool wrapper and reproduces AgentSession's error/result-hook sequencing; it is not a live model-provider session or an interactive TUI test.

## Timeout contract

- Units are seconds on every surface, including `BashOperations`.
- Defaults: foreground `pwsh` 120; `pwsh_job wait` 120; background/user-shell execution unlimited.
- Explicit zero means unlimited.
- Values must be finite and between zero and `2147483.647`, inclusive. Positive sub-millisecond timeouts round up to 1ms.
- A wait timeout stops waiting, not the job.
- Timeout/cancellation cleanup failures are visible and leave their handles available for a shutdown retry. A retry does not target a process that has since exited.

## Stress methodology

The synthetic tail test feeds 134,217,728 UTF-16 code units of emoji (256 MiB of UTF-8-equivalent data), asserting the retained tail never exceeds 400,000 code units and never starts with half a surrogate pair. This is not a 256 MiB allocation: the chunk is reused.

The real foreground test emits about 32 MiB of ASCII output, changes cwd, and prints a final sentinel. It asserts bounded final/partial results, truncation metadata, final preview delivery, persistent cwd, and no leaked control record. The user-shell test forwards about 16 MiB to a counting consumer that retains only a 100-character tail.

Final full-suite and repeated focused runs produced:

- Foreground: roughly 0.91–0.94s, 4 previews, and 33,158,546 dropped characters.
- User-shell adapter: roughly 0.48s, 398–416 incremental chunks.
- Quiet inherited pipes: roughly 0.61–0.71s including shell startup, versus a descendant holding pipes for 2.5s after its launch.
- Active descendants: all ten late chunks and the final sentinel retained.

Timing/RSS diagnostics are observational, not performance guarantees. RSS changes (about 5–93 MB across observed runs) include VM allocation/GC behavior and are **not** evidence of a process-wide memory cap. The deterministic memory assertion is about retained output and parser state; an incoming chunk and transient string/snapshot allocations also occupy memory.

## Security and behavior boundaries

- Executable discovery, fixed UTF-8 stdin transport, no forced execution-policy bypass, and metadata-only automatic notifications remain unchanged.
- The runner has no output-file persistence. Pi 0.87.1's separate `!`/`!!` consumer can still spill large output to `pi-bash-*.log`; no claim is made that replacing its execution adapter disables that host behavior.
- A managed job represents its parent shell. Independently detached descendants are not adopted as managed jobs. Once the parent exits, stopping capture is not a promise to kill those descendants.
- Idle-grace closure explicitly marks output as potentially incomplete. Output arriving after that boundary can be lost. Active draining remains cancellable and subject to any configured execution deadline.
- A user-requested background job survives the originating tool call's cancellation after successful launch; explicit job controls and session teardown own its lifetime.
- Returned output remains untrusted data and normal Pi transcript persistence still applies. This is not a sandbox or a general defense against malicious PowerShell commands.

## Final verification

- `npm run check`: typecheck passed; **53/53 unit tests and 39/39 integration tests passed**, zero skipped or failed.
- Repeated focused real-process stress/protocol suite: **6/6 passed** on the final implementation (also passed in preceding repeat rounds).
- `git diff --check`: passed.
- `npm pack --dry-run --json`: passed; verified that `src/execution.ts` is included.
- These execution improvements are included in the `v0.5.0-secure.5` release contents; GitHub branch/tag publication is verified separately. No system Pi package installation update is part of this validation.

## Reproduce

```powershell
npm run check
node --experimental-strip-types --test --test-name-pattern='execution stress|user-shell stress|inherited pipes|protocol failure|protocol cancellation' test/run-tests.mts
git diff --check
npm pack --dry-run --json
```
