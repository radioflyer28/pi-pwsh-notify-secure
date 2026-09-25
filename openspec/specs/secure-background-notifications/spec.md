# Secure Background Notifications Specification

## Purpose

Deliver reliable background-job state changes to the agent without autonomously injecting untrusted command source or process output into model context.

## Requirements

### Requirement: Metadata-only automatic messages
Automatic ready and finished messages sent to model context SHALL contain only the job id, status, and runtime plus a warning that command and process output are omitted and untrusted. They SHALL NOT include command text, job names, matched lines, process output, or log paths.

#### Scenario: Job finishes with adversarial output
- **WHEN** a background job prints text that resembles agent instructions and then exits
- **THEN** the automatic model-facing message contains the job metadata but none of the printed text or command source

#### Scenario: Ready expression matches sensitive text
- **WHEN** a `notify_on` expression matches a line containing sensitive or instruction-like content
- **THEN** the automatic ready message reports only that the job is ready and omits the matching line

### Requirement: Compact custom rendering
Automatic events SHALL be stored as custom messages and rendered in the TUI as compact job-status rows. Renderer details MAY include safe display metadata such as a user-provided job label but SHALL NOT contain command source or process output.

#### Scenario: Notification is displayed
- **WHEN** a ready or finished event is delivered in interactive mode
- **THEN** the transcript shows a compact status row rather than a user-message block or process-output transcript

### Requirement: Bounded batched delivery
Notification events SHALL be debounced into bounded batches with limits on event count and serialized content size so simultaneous job events do not create unbounded messages or unnecessary model calls.

#### Scenario: Many jobs finish together
- **WHEN** more jobs finish than one configured batch permits
- **THEN** events are split into multiple bounded batches and each job event is delivered at most once

### Requirement: Finite retry on delivery failure
A failed notification send SHALL be retried with bounded attempts and delay. After the attempt limit, the event SHALL be dropped with an observable local error and SHALL NOT retry indefinitely.

#### Scenario: First send fails transiently
- **WHEN** the first attempt to send a notification throws and a later attempt succeeds
- **THEN** the event is delivered once without being lost or duplicated

#### Scenario: All attempts fail
- **WHEN** every allowed send attempt fails
- **THEN** retries stop and the extension reports how many notifications were dropped

### Requirement: Suppress redundant observed events
If an explicit `pwsh_job output` or `pwsh_job wait` operation reports the same ready or finished state before its queued automatic event is delivered, the queued event SHALL be cancelled. A completed state already reported by an explicit output call SHALL remain observed for later notification decisions.

#### Scenario: Wait observes job exit
- **WHEN** a wait call returns the job's terminal state before the finished notification is sent
- **THEN** no redundant finished automatic message is delivered

#### Scenario: Output observes completed job
- **WHEN** an output call reports that a job has already completed
- **THEN** a queued finished event is cancelled and no later duplicate is sent

### Requirement: Steering delivery behavior
Automatic messages SHALL use Pi's steering delivery channel and SHALL request a turn only when needed to wake an idle agent. Delivery SHALL remain safe during active turns and SHALL not survive session shutdown.

#### Scenario: Agent is active
- **WHEN** a job event occurs during an agent run
- **THEN** the event is queued for the next valid steering boundary rather than impersonating user input

#### Scenario: Session shuts down before delivery
- **WHEN** a notification is pending at session shutdown
- **THEN** it is disposed and cannot appear in a replacement session
