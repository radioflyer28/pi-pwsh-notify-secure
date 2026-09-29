# Maintaining the secure fork against upstream

## Reviewed baseline and drift check

The last reviewed upstream release is [`v0.5.0`](https://github.com/oversk7/pi-pwsh-notify/releases/tag/v0.5.0), commit `4a7a48a`. The current fork was **selectively adapted onto older fork history**, not merged from that tag. A clean `git merge` cannot by itself establish that upstream 0.5.0 behavior is present. The [adaptation matrix](../research/upstream-0.5.0-secure-adaptation.md) records what was adopted and intentionally rejected.

Run `npm run check:upstream -- --fetch` to fetch the upstream remote and compare `upstream/main` to that reviewed tag. Without `--fetch`, the command checks only locally fetched refs. The read-only GitHub Actions workflow is scheduled weekly **once it is on this fork's default branch**; GitHub does not run scheduled workflows from feature branches. It reports newly added upstream commits and never merges, opens an issue, or changes installation settings. A nonzero exit means review is required, not that the fork should automatically take the commit. Once a newer release has been fully reviewed, update the baseline tag and pinned commit in `scripts/check-upstream.mts` **and** add a new adaptation matrix in the same reviewable change.

## Sync checklist for each upstream release

1. Create a separate review branch from the current fork; leave published tags and the installed Pi ref untouched. Start with `npm run check:upstream -- --fetch`, `git log --oneline v0.5.0..upstream/main`, and `git diff v0.5.0..upstream/main -- src package.json test`. Substitute the new reviewed baseline for `v0.5.0` after an approved sync.
2. Compare upstream behavior against the matrix. Record each change as adopted, already present, adapted with constraints, rejected with rationale, or deferred. Pay special attention to `src/index.ts` (shared orchestration), `src/runtime.ts`, and `src/notification-queue.ts`.
3. Prefer small, reviewable patches. Keep fork policy behind `src/security.ts`, `src/notifications.ts`, `src/tool-selection.ts`, and `src/ui/powershell-tool-renderers.ts`. Move policy out of `src/index.ts` when touching nearby code; do not refactor it merely for a cosmetic diff. A merge is allowed only after reviewing all incoming behavior; resolved conflicts are not proof of security compatibility.
4. Preserve these invariants: absolute and probed PowerShell paths; absolute System32 `taskkill.exe`; no `-ExecutionPolicy Bypass`; metadata-only automatic notifications and renderer details; no default complete-output disk logs; both built-in shells hidden only while the secure runtime works; bounded outputs, lifecycle and shutdown; `private: true` and the secure install ref.
5. Run `npm run check`, `npm pack --dry-run --json`, `node --experimental-strip-types test/manual-smoke.mts`, and `pi --list-models -e ./src/index.ts` on the supported Windows/Pi environment. Compare result and model-context behavior before updating the reviewed baseline. Install a **new tested tag**, never a moving upstream branch.
6. Ask the maintainer to review upstream issue/PR drafts before filing. Never push to `upstream` or open issues automatically as part of synchronization.

Current proposals for maintainer review: [upstream-contribution-drafts.md](upstream-contribution-drafts.md). Neither that document nor the drift check submits anything upstream.
