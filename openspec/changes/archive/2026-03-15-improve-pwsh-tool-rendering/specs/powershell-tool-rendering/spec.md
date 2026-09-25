# Spec Delta

## Purpose

Make every model-facing PowerShell tool block in the package understandable in collapsed form and fully inspectable through Pi's standard tool-output expansion behavior.

## ADDED Requirements

### Requirement: All PowerShell tools have purpose-built rendering
The package SHALL provide custom interactive TUI rendering for every model-facing PowerShell tool it registers, currently `pwsh` and `pwsh_job`. Rendering SHALL NOT alter tool parameters, execution behavior, model-facing results, or notification security boundaries.

#### Scenario: PowerShell tools are registered
- **WHEN** Pi renders a `pwsh` or `pwsh_job` call from this package
- **THEN** the tool uses the package's purpose-built call and result presentation rather than Pi's generic fallback renderer

### Requirement: Rendering is isolated from model context
The custom renderers SHALL be a user-interface-only projection of existing tool calls and results. They SHALL NOT mutate or replace tool-call arguments, tool-result content, tool-result details, tool definitions exposed to the model, or the serialization of those values into the model's context window. Collapsing or expanding a block SHALL affect only terminal presentation.

#### Scenario: Tool call is rendered
- **WHEN** either PowerShell tool's call arguments are rendered in collapsed or expanded mode
- **THEN** the arguments supplied to execution and serialized for the model remain identical to the unrendered arguments

#### Scenario: Tool result is rendered
- **WHEN** a partial, successful, or failed result is rendered in collapsed or expanded mode
- **THEN** the content and details retained for model context remain identical to the execution result before rendering

#### Scenario: User toggles expansion
- **WHEN** the user changes a PowerShell tool block between collapsed and expanded presentation
- **THEN** no conversation message, tool call, tool result, or subsequent model request is changed

### Requirement: pwsh call blocks identify the command
A `pwsh` tool block SHALL display a PowerShell prompt and the invoked command before its result. Collapsed rendering SHALL preserve the beginning of the command and SHALL visibly indicate when long or multi-line command text is omitted.

#### Scenario: Short command is invoked
- **WHEN** `pwsh` executes a command that fits within the available collapsed command area
- **THEN** the complete command is visible above its output preview

#### Scenario: Long or multi-line command is invoked
- **WHEN** the command exceeds the collapsed command preview
- **THEN** the beginning of the command is visible and an omission indicator shows that more command text exists

#### Scenario: Background command is invoked
- **WHEN** `pwsh` is called with `run_in_background: true`
- **THEN** the block shows the command and clearly identifies it as a background invocation

### Requirement: pwsh_job call blocks identify the operation
A `pwsh_job` tool block SHALL display the action, target job id when applicable, and action-relevant options such as line count, wait pattern, or timeout. Collapsed rendering SHALL truncate long pattern text safely while preserving the operation's identity.

#### Scenario: Job output is requested
- **WHEN** `pwsh_job` is called with action `output`
- **THEN** the block identifies the output action, job id, and requested line behavior

#### Scenario: Job wait is requested
- **WHEN** `pwsh_job` is called with action `wait`
- **THEN** the block identifies the wait action, job id, pattern when present, and timeout when present

#### Scenario: Jobs are listed or killed
- **WHEN** `pwsh_job` is called with action `list` or `kill`
- **THEN** the block displays the action and target id when the action has one

### Requirement: Collapsed results show a useful output preview
A completed or streaming PowerShell tool block SHALL show a compact tail preview of its available textual result. The preview SHALL be bounded by visual terminal lines, SHALL preserve the most recent output, and SHALL indicate how much earlier content is hidden.

#### Scenario: Result fits in the preview
- **WHEN** a tool result occupies no more than the collapsed preview limit
- **THEN** all available result text is visible without a false omission indicator

#### Scenario: Result exceeds the preview
- **WHEN** a tool result exceeds the collapsed preview limit
- **THEN** the most recent visual lines are shown with an indication that earlier lines are hidden

#### Scenario: Result is streaming
- **WHEN** partial output updates arrive while `pwsh` is executing
- **THEN** the command header remains stable and the collapsed preview updates to the newest available output

### Requirement: Standard Ctrl-O expansion is supported
The renderers SHALL use Pi's existing expanded-state contract so `app.tools.expand` toggles between collapsed and expanded content. The package SHALL NOT register or intercept a separate expansion shortcut.

#### Scenario: User presses the default expansion key
- **WHEN** focus is in Pi's normal editor and the user presses `Ctrl-O`
- **THEN** PowerShell tool blocks toggle between collapsed and expanded rendering with other tool blocks

#### Scenario: User customizes the expansion key
- **WHEN** `app.tools.expand` is rebound in Pi's keybindings
- **THEN** the PowerShell tool blocks continue to expand through the rebound action without package changes

### Requirement: Expansion hints respect configured keybindings
When content is omitted in collapsed mode, the block SHALL display a concise expansion hint generated from Pi's `app.tools.expand` keybinding rather than hard-coding `Ctrl-O`.

#### Scenario: Default keybinding is active
- **WHEN** collapsed content is omitted under the default configuration
- **THEN** the hint identifies `Ctrl-O` as the expansion action

#### Scenario: Expansion key is rebound
- **WHEN** the user changes the `app.tools.expand` binding
- **THEN** the hint displays the configured key text

### Requirement: Expanded rendering shows all available invocation and result content
Expanded rendering SHALL show the complete tool invocation and all textual result content retained in the tool result. Expansion SHALL not reconstruct output that was already truncated by execution limits.

#### Scenario: Collapsed command and output were shortened
- **WHEN** the user expands the tool block
- **THEN** the complete invocation and all available result text replace the collapsed previews

#### Scenario: Execution output was bounded before rendering
- **WHEN** the tool result itself contains a truncation notice or bounded tail
- **THEN** expansion displays that complete bounded result and does not claim unavailable output exists

### Requirement: Status, errors, and timing remain visible
The renderers SHALL distinguish active, successful, and failed tool states and SHALL display elapsed or completed duration when timing information is available. Existing timeout, abort, exit-code, and validation messages SHALL remain visible in both collapsed and expanded modes.

#### Scenario: Tool is still running
- **WHEN** a partial result is rendered
- **THEN** the block indicates active execution and updates elapsed time without hiding current output

#### Scenario: Tool fails
- **WHEN** execution produces an error result or non-success status text
- **THEN** the block uses error styling and keeps the failure information visible

### Requirement: Rendering is terminal-width safe
Every rendered line SHALL fit the width supplied by Pi and SHALL measure visible columns correctly for ANSI styling, wide characters, emoji, and combining characters.

#### Scenario: Narrow terminal renders a long invocation
- **WHEN** the terminal is narrower than the command or job-operation summary
- **THEN** every rendered line remains within the supplied width and the block does not wrap unpredictably outside its shell

#### Scenario: Output contains styled or wide text
- **WHEN** output includes ANSI styling or wide Unicode characters
- **THEN** preview and expanded rendering preserve valid styling while respecting visible terminal width
