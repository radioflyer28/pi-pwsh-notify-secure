# Proposal

## Why

Upstream `pi-pwsh-notify` 0.5.0 adds valuable runtime, job-management, notification, and test reliability improvements, but merging it directly would undo this fork's core security guarantees. We should selectively adapt those improvements so the secure fork gains upstream reliability while retaining trusted executable resolution, metadata-only notifications, and compatibility with Pi 0.87.1.

## What Changes

- Port upstream's stdin-based PowerShell transport, robust exit-status handling, UTF-8 stream decoding, serialized working-directory updates, Pi session environment variables, and `!`/`!!` PowerShell routing.
- Preserve verified absolute resolution for PowerShell and `taskkill.exe`, and continue to omit `-ExecutionPolicy Bypass`.
- Gracefully disable the extension tools when no trusted PowerShell runtime is available while leaving Pi's built-in shell tools usable.
- Port background-job cursor rollover tracking, bounded Pi-standard tool output, terminal-state observation, kill-error reporting, and stronger shutdown settling.
- Port the bounded, retryable, cancellable notification queue while keeping all automatic steering messages metadata-only.
- Continue excluding command text, matched output, process output, and log paths from automatic notifications.
- Do not adopt upstream's default full-output temporary logs in this release; command output remains available only through explicit tool results and the bounded in-memory job buffer.
- Preserve removal of both Pi built-in shell tools (`bash` and `powershell`) when the secure replacement is active, plus conditional `grep`/`find` pruning when pi-fff replacements exist.
- Adopt upstream's TypeScript configuration and broad integration-test coverage, adapted to this fork's package metadata, `typebox`, security requirements, and Pi 0.87.1.
- Prepare the package as `0.5.0-secure.1` while retaining `private: true` and secure-fork repository/install metadata.

## Capabilities

### New Capabilities
- `secure-powershell-execution`: Trusted PowerShell discovery and execution, stdin command transport, exit semantics, session environment exposure, cwd persistence, and user shell shortcut routing.
- `background-job-management`: Reliable session-scoped job output, bounded buffers, incremental reads and waits, process-tree termination, and lifecycle cleanup.
- `secure-background-notifications`: Bounded and retryable ready/finished notification delivery that exposes metadata only and suppresses redundant observed events.

### Modified Capabilities

None. This project does not yet contain main capability specifications.

## Impact

- Primary implementation: `src/index.ts`, `src/security.ts`, and new or extracted runtime/notification modules.
- Tests: current security tests plus adapted upstream integration, lifecycle, UI, notification-queue, and real-PowerShell tests.
- Package tooling: `package.json`, `package-lock.json`, `tsconfig.json`, and test scripts/development dependencies.
- Documentation: `README.md` and the Pi comparison/research documentation.
- Runtime compatibility: Windows, Node.js 22.19+, Pi/TUI 0.87.1, PowerShell 7 preferred with the existing trusted Windows PowerShell fallback retained unless implementation evidence requires narrowing support.
