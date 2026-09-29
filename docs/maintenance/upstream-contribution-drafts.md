# Upstream contribution drafts — review before filing

**Drafts only. Nothing here has been submitted to `oversk7/pi-pwsh-notify`.** Comparison target: upstream `v0.5.0` (`4a7a48a`). Before filing, recheck upstream HEAD and search existing issues/PRs for duplicates; adapt the wording to the then-current code. Each upstream PR should be small and include a Windows regression test. The fork's private metadata, install instructions, and OpenSpec files are not proposed for upstream.

## 1. Issue: Resolve shell and process cleanup executables by absolute path

**Problem:** In v0.5.0, runtime discovery can invoke unqualified `where.exe`/PowerShell names and cleanup can invoke unqualified `taskkill.exe`. Unqualified launches may resolve differently based on process cwd or PATH, including directories the caller controls. A path being absolute does *not* prove the binary's authenticity; this change narrows ambiguous name resolution, not arbitrary replacement of a trusted file.

**Proposed scope:** Enumerate only absolute PowerShell candidates (PowerShell 7 preferred, Windows PowerShell fallback), reject relative explicit overrides, and probe the selected executable. Launch `taskkill.exe` from the Windows system directory with an absolute path. Preserve a clean fallback when no supported runtime is available. Test cwd lookalikes, relative/empty PATH entries, explicit overrides, and process-tree cleanup failure. Fork references: `src/security.ts`, `tests/security.test.ts`, `tests/runtime.test.ts`, `test/run-tests.mts`.

**Review question:** Should upstream retain a deliberate opt-in for relative overrides, or reject them outright? If this is accepted, split discovery and taskkill cleanup into separate PRs if helpful.

## 2. Issue: Do not pass `-ExecutionPolicy Bypass` automatically

**Problem:** In v0.5.0, the extension forces a policy override for probes and launched commands, contrary to some users' local policy expectations. We should not imply that execution policy alone is a security boundary; this is about respecting user/admin configuration and avoiding unnecessary overrides.

**Proposed scope:** Omit the flag from probe and execution arguments. Preserve stdin bootstrap behavior and add tests for both PowerShell 7 and Windows PowerShell fallback. Fork references: `src/security.ts`, `src/runtime.ts`, `tests/runtime.test.ts`.

**Review question:** Are there supported scenarios that need an explicit, *opt-in* override? Keep this separate from absolute-path resolution if upstream prefers narrower changes.

## 3. Issue: Keep automatic job notifications metadata-only

**Problem:** v0.5.0 can place command source, matched ready text, or process output in automatic model-facing notifications. These can contain secrets or untrusted instructions, and they arrive without an explicit output read.

**Proposed scope:** Construct ready/finished notifications and their renderer details from job id, state, runtime, and other non-output metadata only. Keep output accessible through explicit `pwsh_job output`/`wait`; continue suppressing duplicate ready/finished notifications after the state is observed. Test adversarial command/output and ready-regex matches in both message content and details. Fork references: `src/notifications.ts`, `tests/security.test.ts`, notification tests in `test/run-tests.mts`.

**Review question:** Would upstream accept the privacy-preserving default, or want an explicit opt-in for output excerpts? Never present an excerpt as trusted instructions.

## 4. Issue: Make complete-output disk logs opt-in

**Problem:** v0.5.0 writes complete command output to temporary/persistent files by default and exposes paths. Output often contains credentials or private project data. Returning a bounded result does not eliminate that on-disk retention.

**Proposed scope:** Use bounded in-memory tails by default; retain any required diagnostic logging behind an explicit user opt-in with documented retention, location, permissions, and cleanup. Keep `lines: 0` bounded. Test that ordinary foreground/background commands create no default complete logs. Fork references: `src/index.ts`, `tests/security.test.ts`, privacy and bounded-output integration tests in `test/run-tests.mts`.

**Review question:** Is there a documented upstream workflow that depends on complete logs? If so, design the opt-in before changing the default.

## 5. Discussion: Hide both built-in shell tools while the runtime is active

**Problem:** If Pi's built-in `bash` or `powershell` remains model-visible beside the managed `pwsh` tool, calls may bypass the extension's background jobs and execution constraints. This is a product choice, not universally desirable behavior.

**Proposed scope:** While the secure runtime is available, expose a single model-facing shell by removing both built-in shell tools from active tools. If runtime detection fails, hide extension tools and preserve Pi's built-ins. Consider a configurable mode for users who explicitly want multiple shells. Fork references: `src/tool-selection.ts`, `tests/security.test.ts`.

**Review question:** Should this be the upstream default, a preference, or only documented guidance? Start with discussion, not a behavior-changing PR.

## Lower-priority UI option

The fork's `pwsh`/`pwsh_job` renderers (`src/ui/powershell-tool-renderers.ts`) offer command previews, output tails, status/timing, and width-aware expansion. Upstream may prefer a different visual style. Offer this as a separate, optional UI proposal only after confirming public API compatibility and carrying the redraw-cache regression test; it does not belong in a security PR.

## Already in upstream v0.5.0 — do not propose as new features

Fixed-bootstrap BOM-less UTF-8 stdin transport, native/cmdlet exit semantics, UTF-8 decoding/CR normalization, serialized cwd, Pi environment injection, runtime-aware behavior, notification queue mechanics, output cursors, and bounded result sizes were adapted *from* v0.5.0. We can offer focused edge-case tests or fixes, not claim them as fork inventions.
