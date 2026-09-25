# Background Job Management Specification

## Purpose

Provide reliable session-scoped foreground and background PowerShell execution with bounded model output, incremental observation, and deterministic cleanup.

## Requirements

### Requirement: Session-scoped managed jobs
A command started with `run_in_background: true` SHALL return a job identifier immediately, continue outside the initiating tool call, and remain owned by the current Pi session.

#### Scenario: Background job starts
- **WHEN** the model starts a valid command in background mode
- **THEN** the tool returns a job id and the process continues running

### Requirement: UTF-8 stream integrity
Foreground and background output SHALL be decoded without corrupting multi-byte UTF-8 characters that cross process stream chunk boundaries, and Windows carriage returns SHALL be normalized before model or TUI rendering.

#### Scenario: Multi-byte character spans chunks
- **WHEN** a UTF-8 character is split across adjacent output chunks
- **THEN** the captured output contains the original character without replacement or corruption

#### Scenario: Windows line endings are emitted
- **WHEN** output contains CRLF or bare carriage-return progress updates
- **THEN** rendered and returned output contains normalized line breaks and no raw carriage return

### Requirement: Bounded in-memory output with absolute cursors
Each job SHALL keep a bounded in-memory output tail and SHALL track observation cursors as absolute stream offsets. If unseen output rolls out of memory, the next explicit read or wait result SHALL state that output was missed.

#### Scenario: Buffer rolls over before read
- **WHEN** a job produces more output than the in-memory limit before the model reads it
- **THEN** the oldest output is discarded, remaining output is returned safely, and the result warns that unseen output rolled out of memory

#### Scenario: Concurrent output reads occur
- **WHEN** multiple output or wait calls consume one job concurrently
- **THEN** cursor advancement is serialized and no output segment is reported twice

### Requirement: Standard bounded tool results
Foreground output and `pwsh_job` output or wait results SHALL be bounded by Pi's standard maximum byte and line limits. A `lines` argument SHALL never permit an unbounded model-facing result.

#### Scenario: Foreground output exceeds limits
- **WHEN** a foreground command exceeds Pi's standard tool-output limits
- **THEN** the tool returns a clearly marked tail within both limits

#### Scenario: Full-buffer output is requested
- **WHEN** `pwsh_job output` is called with `lines: 0`
- **THEN** the result uses the complete available in-memory tail subject to Pi's standard tool-output limits

### Requirement: Explicit incremental output and blocking wait
`pwsh_job output` SHALL return only output not previously consumed unless `lines: 0` requests the available buffer. `pwsh_job wait` SHALL block until unseen output matches the requested regular expression, the job exits, the wait times out, or the operation is aborted.

#### Scenario: Repeated incremental reads
- **WHEN** output is read twice with new data produced between calls
- **THEN** the second result contains the new data and does not repeat data consumed by the first result

#### Scenario: Wait pattern matches
- **WHEN** unseen job output matches the requested regular expression
- **THEN** the wait returns the matching line and newly available output without stopping the job

#### Scenario: Wait times out
- **WHEN** the pattern does not match before the wait timeout
- **THEN** the wait returns a timeout status and leaves the job running

### Requirement: Safe process-tree termination
Timeout, abort, explicit kill, session shutdown, and supported process termination signals SHALL attempt to terminate the complete child process tree using the trusted absolute termination utility. Cleanup failures during an active tool operation SHALL be surfaced rather than reported as successful termination.

#### Scenario: Explicit kill succeeds
- **WHEN** `pwsh_job kill` targets a running job
- **THEN** the complete process tree is terminated and the result reports success

#### Scenario: Termination fails
- **WHEN** the process remains running after the termination utility fails
- **THEN** the operation reports a cleanup error

### Requirement: Deterministic job settlement and shutdown
A job SHALL not be marked fully finished until final decoded output has been captured and asynchronous resources have settled. Session shutdown SHALL suppress late notifications, dispose UI and queue resources, terminate running jobs, and wait only for a bounded cleanup interval.

#### Scenario: Process closes with trailing output
- **WHEN** the process streams final bytes immediately before closing
- **THEN** those bytes are decoded and available before the job is finalized

#### Scenario: Session ends with running jobs
- **WHEN** the session is reloaded, replaced, forked, or quit while jobs remain active
- **THEN** their process trees are reaped and no completion event leaks into the next session

### Requirement: No default persistent command logs
The extension SHALL NOT write complete command or job output to persistent or temporary log files by default. Output SHALL remain within explicit tool results, live previews, the TUI viewer, and the bounded in-memory job buffer.

#### Scenario: Command produces sensitive output
- **WHEN** a foreground or background command emits output
- **THEN** the extension creates no default full-output log file or log-path disclosure
