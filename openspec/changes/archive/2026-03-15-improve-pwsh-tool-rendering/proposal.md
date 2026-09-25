# Proposal

## Why

The package's `pwsh` and `pwsh_job` tools currently fall back to Pi's generic tool renderer, so completed blocks can show results without enough invocation context, as demonstrated for `pwsh` in `screenshot.png`. Every PowerShell-related tool block should remain understandable at a glance and use Pi's standard `Ctrl-O` expansion behavior just like built-in tools.

## What Changes

- Add custom `renderCall` and `renderResult` behavior to both `pwsh` and `pwsh_job` as a display-only layer. The tool-call arguments and tool-result content serialized into the model's context window remain unchanged, regardless of collapsed or expanded UI state.
- For `pwsh`, always show a PowerShell-style command header containing the beginning of the invoked command, with width-aware truncation for long or multi-line commands.
- For `pwsh_job`, always show a compact invocation header containing the action, job id, and relevant wait/output options.
- In collapsed mode, show a compact tail preview of each tool's result and indicate when earlier output, result text, or command text is hidden.
- In expanded mode, show the complete invocation and all result content available in the bounded tool result.
- Respect Pi's standard `app.tools.expand` action, whose default binding is `Ctrl-O`, rather than registering an extension-specific shortcut.
- Display the configured expansion key through Pi's key-hint API so user keybinding overrides remain accurate.
- Preserve useful streaming state, error styling, timeout/exit information, duration, narrow-terminal safety, and ANSI-aware visual widths.
- Add focused renderer tests covering collapsed, expanded, streaming, error, multiline-command, and narrow-width behavior.
- Keep this work independent from the upstream 0.5.0 security/reliability integration change so either proposal can be reviewed and applied separately.

## Capabilities

### New Capabilities
- `powershell-tool-rendering`: User-facing TUI presentation for all model-facing PowerShell tools provided by the package (`pwsh` and `pwsh_job`), including invocation summaries, result previews, streaming state, and standard tool expansion.

### Modified Capabilities

None. This project does not yet contain main capability specifications.

## Impact

- Primary implementation: the `pwsh` and `pwsh_job` tool definitions in `src/index.ts` and a shared focused renderer module if extraction improves testability.
- Public behavior: interactive Pi TUI display only. Tool definitions exposed to the model, serialized call arguments, execution, serialized result content, notifications, and the model's context-window representation remain unchanged.
- Dependencies: public Pi rendering helpers such as `keyHint` and `truncateToVisualLines`, plus `@earendil-works/pi-tui` components and width utilities already available through the package's Pi/TUI peer dependencies.
- Tests and documentation: renderer unit tests and a README note or screenshot documenting collapsed and expanded behavior.
