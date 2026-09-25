# Tasks

## 1. Renderer Test Harness

- [x] 1.1 Add renderer-focused test helpers for mock themes, render contexts, widths, partial results, and expansion states; verify the helpers can render a minimal component to lines without starting Pi.
- [x] 1.2 Add a registration test asserting that both `pwsh` and `pwsh_job` expose custom `renderCall` and `renderResult` functions; verify the test fails against the pre-change tool definitions.
- [x] 1.3 Capture model-visible projections for both tools—name, description, parameter schema, call arguments, result content, and result details—and add equivalence helpers that compare them before and after rendering.

## 2. Shared Rendering Primitives

- [x] 2.1 Create a focused PowerShell tool-renderer module using only public Pi and TUI exports; verify TypeScript resolves it without internal `dist/` imports or new runtime dependencies.
- [x] 2.2 Implement ANSI- and Unicode-aware helpers for head-previewing invocations and tail-previewing results by visual lines; verify tests cover narrow widths, wrapping, wide characters, combining characters, and styled text.
- [x] 2.3 Implement omission labels using Pi's `app.tools.expand` key hint; verify tests demonstrate both the default `Ctrl-O` label and a mocked custom binding without hard-coded shortcut text.
- [x] 2.4 Keep renderer transformations pure and presentation-local; verify deep-frozen call arguments and partial/success/error results render in collapsed and expanded modes without mutation or attempts to append UI text to stored result content.

## 3. pwsh Invocation Rendering

- [x] 3.1 Implement the `pwsh` call renderer with a `PS>` prompt, command, background marker, name, timeout, and `notify_on` summary; verify focused tests cover foreground and background argument combinations.
- [x] 3.2 Add collapsed head truncation and expanded full-command rendering for long and multi-line commands; verify the beginning is retained when collapsed and every available command line appears when expanded.
- [x] 3.3 Make invocation rendering defensive for incomplete streaming arguments and narrow terminal widths; verify no rendered line exceeds each tested width and malformed partial arguments do not throw.

## 4. pwsh_job Invocation Rendering

- [x] 4.1 Implement action-oriented call summaries for `list`, `output`, `wait`, and `kill`; verify tests assert the action, applicable job id, and relevant options for every action.
- [x] 4.2 Add width-aware collapsed truncation and expanded display for wait patterns and other long values; verify long patterns are clearly shortened in collapsed mode and complete in expanded mode.
- [x] 4.3 Handle incomplete or invalid job-action arguments defensively; verify renderer tests return an understandable summary instead of throwing.

## 5. Result Rendering and Streaming State

- [x] 5.1 Implement the shared collapsed result tail with a five-visual-line initial limit and earlier-content count; verify fitting output has no false omission marker and long output preserves its newest lines.
- [x] 5.2 Implement expanded rendering of all textual content retained in each tool result; verify expansion removes only renderer-level clipping and preserves execution-level truncation notices.
- [x] 5.3 Preserve active, successful, and error presentation plus timeout, abort, exit, wait, and validation status text; verify partial, success, and failure fixtures retain their diagnostic content in both modes.
- [x] 5.4 Implement elapsed-time updates and component reuse for partial results with reliable timer cleanup; verify fake-timer tests cover streaming updates, completion, error, and disposal without leaked intervals.

## 6. Tool Integration

- [x] 6.1 Attach the custom call and result renderers to `pwsh` while retaining Pi's default tool shell; verify existing execution tests pass and a renderer integration test shows command plus result together.
- [x] 6.2 Attach the custom call and result renderers to `pwsh_job`; verify existing job-management tests pass and all four actions render with invocation context.
- [x] 6.3 Verify the renderer introduces no execution, tool-schema/description, call-argument, result-content/details, notification-content, tool-selection, conversation-message, or model-request changes by running the model-visible projection equivalence tests, reviewing the implementation diff, and running the package's complete automated check.

## 7. Documentation and Compatibility Verification

- [x] 7.1 Update the README with collapsed and expanded behavior for both PowerShell tools and explain that expansion uses the configurable `app.tools.expand` action (`Ctrl-O` by default); verify documentation mentions no extension-specific shortcut.
- [x] 7.2 Smoke-load the extension in Pi 0.87.1 and manually exercise `pwsh` foreground, background, failure, and streaming cases plus every `pwsh_job` action at normal and narrow terminal widths; capture the observed checks in the implementation notes or commit message.
- [x] 7.3 Run the full TypeScript and test suite, then inspect diffs against the implementation base and the separate `integrate-upstream-0-5-securely` proposal; verify all checks pass and any overlap is limited to small renderer attachments in tool definitions.
