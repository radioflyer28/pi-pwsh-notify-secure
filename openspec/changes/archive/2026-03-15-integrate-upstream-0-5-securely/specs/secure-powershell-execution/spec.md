# Spec Delta

## Purpose

Provide PowerShell command execution on Windows without weakening executable trust, execution-policy controls, shell selection, or command-transport reliability.

## ADDED Requirements

### Requirement: Trusted executable resolution
The extension SHALL launch PowerShell and process-tree termination utilities only through verified absolute paths. It SHALL ignore empty or relative `PATH` entries, SHALL NOT use an unqualified executable-discovery subprocess, and SHALL resolve `taskkill.exe` from the trusted Windows system directory.

#### Scenario: Repository contains executable lookalikes
- **WHEN** the current working directory contains files named `pwsh.exe`, `powershell.exe`, `where.exe`, or `taskkill.exe`
- **THEN** the extension does not execute those files and uses only verified absolute candidates

#### Scenario: Relative PATH entry is present
- **WHEN** `PATH` contains an empty or relative directory entry
- **THEN** that entry is ignored during PowerShell discovery

### Requirement: Runtime selection and graceful fallback
The extension SHALL prefer a trusted PowerShell 7 runtime and SHALL retain the existing trusted Windows PowerShell fallback. If no supported runtime is available, it SHALL deactivate `pwsh` and `pwsh_job`, notify the user when UI is available, and leave Pi's built-in shell tools available.

#### Scenario: PowerShell 7 is available
- **WHEN** a trusted PowerShell 7 executable is found
- **THEN** the extension activates its tools using that executable

#### Scenario: Only Windows PowerShell is available
- **WHEN** no trusted PowerShell 7 executable exists but trusted Windows PowerShell is available
- **THEN** the extension activates its tools using the Windows PowerShell fallback

#### Scenario: No trusted PowerShell is available
- **WHEN** no supported executable can be resolved from trusted absolute candidates
- **THEN** the extension tools are inactive and Pi's built-in shell tools remain available

### Requirement: Execution policy is not bypassed
The extension SHALL NOT add `-ExecutionPolicy Bypass` or another command-line policy override when probing or launching PowerShell.

#### Scenario: Runtime arguments are inspected
- **WHEN** the extension probes or starts a PowerShell process
- **THEN** the process arguments contain no execution-policy bypass flag

### Requirement: Reliable stdin command transport
The extension SHALL transport user command source through BOM-less UTF-8 standard input using a fixed PowerShell bootstrap, so command length and nested quoting do not depend on Windows command-line parsing.

#### Scenario: Long command source is executed
- **WHEN** a command contains source substantially longer than the Windows command-line limit
- **THEN** the complete command reaches PowerShell and executes without argument-length truncation

#### Scenario: Command contains nested quotes
- **WHEN** a command contains nested PowerShell, JSON, or native-process quoting
- **THEN** the command is evaluated with its original source text intact

### Requirement: Correct command outcome reporting
The extension SHALL preserve native process exit codes, map a final failed PowerShell operation without a native code to exit code 1, and report success when a later successful operation clears an earlier failure.

#### Scenario: Native command fails
- **WHEN** the final native command exits with code 3
- **THEN** the tool result reports exit code 3

#### Scenario: PowerShell operation fails
- **WHEN** the final PowerShell operation fails without a native exit code
- **THEN** the tool result reports exit code 1

#### Scenario: Failure is followed by recovery
- **WHEN** an earlier native command fails and the final command succeeds
- **THEN** the tool result is successful and does not report the stale earlier exit code

### Requirement: Serialized persistent working directory
Foreground calls SHALL execute sequentially and SHALL resolve their starting directory only when they reach the execution queue. A successfully reported final directory SHALL become the starting directory for the next foreground or background command.

#### Scenario: Concurrent calls include a directory change
- **WHEN** concurrent foreground calls are submitted and the first changes directory
- **THEN** the second begins only after the first and observes the updated directory

### Requirement: Pi execution context environment
Commands SHALL receive the current Pi session id, session file, provider, model, and reasoning level through the documented `PI_*` environment variables when those values are available.

#### Scenario: Command reads Pi environment
- **WHEN** a tool command reads the documented Pi session and model environment variables
- **THEN** their values match the current extension context

### Requirement: User shell shortcuts share the secure runtime
When a trusted PowerShell runtime is active, Pi `!` and `!!` commands SHALL execute through the same secure PowerShell operations and persistent working-directory state. When no trusted runtime is active, the extension SHALL return control to Pi's normal user-shell behavior.

#### Scenario: Shortcut executes with active runtime
- **WHEN** the user runs `!` or `!!` while the extension runtime is available
- **THEN** the command executes through the trusted PowerShell runtime

#### Scenario: Shortcut executes without active runtime
- **WHEN** the user runs `!` or `!!` while no trusted runtime is available
- **THEN** the extension does not intercept the command

### Requirement: Single model-facing shell surface
When the secure PowerShell runtime is active, the extension SHALL remove both built-in `bash` and built-in `powershell` from the active model tool set. It SHALL remove `grep` and `find` only when pi-fff replacement tools are active.

#### Scenario: Secure runtime activates
- **WHEN** a session or agent run starts with the secure runtime available
- **THEN** the model sees `pwsh` and `pwsh_job` without competing built-in shell tools
