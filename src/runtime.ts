import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { findPowerShellRuntime, taskkillExecutable, type PowerShellRuntime } from "./security.js";

export interface SpawnPowerShellOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
}

const STDIN_BOOTSTRAP = [
	"$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
	"$__pi_source = [Console]::In.ReadToEnd()",
	"& ([ScriptBlock]::Create($__pi_source))",
].join("; ");

export function powerShellArguments(): string[] {
	return ["-NoProfile", "-NonInteractive", "-Command", STDIN_BOOTSTRAP];
}

/** Resolve validated runtime metadata through the executable trust boundary. */
export function resolvePowerShellRuntime(env: NodeJS.ProcessEnv = process.env): PowerShellRuntime {
	return findPowerShellRuntime(env);
}

/** Spawn a trusted PowerShell executable and transport source as BOM-less UTF-8 stdin. */
export function spawnPowerShell(
	executable: string,
	script: string,
	options: SpawnPowerShellOptions,
): ChildProcess {
	const proc = spawn(executable, powerShellArguments(), {
		cwd: options.cwd,
		env: options.env,
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
	// A fast spawn failure can close stdin before end(); the process error event
	// remains the authoritative failure signal.
	proc.stdin?.on("error", () => {});
	proc.stdin?.end(Buffer.from(script, "utf8"));
	return proc;
}

function quotePowerShellLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/** Build a script that captures final command status and optionally reports cwd. */
export function buildPowerShellScript(command: string, cwdMarker?: string): string {
	const reportCwd = cwdMarker
		? `[Console]::Out.WriteLine(${quotePowerShellLiteral(cwdMarker)} + (Get-Location).Path)`
		: "";
	return [
		"$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
		"$ErrorActionPreference = 'Continue'",
		"$global:LASTEXITCODE = $null",
		"$script:__pi_status_captured = $false",
		"& {",
		command,
		"$script:__pi_ok = $?",
		"$script:__pi_native = $LASTEXITCODE",
		"$script:__pi_status_captured = $true",
		"} | Out-Default",
		"if (-not $script:__pi_status_captured) { $__pi_ok = $?; $__pi_native = $LASTEXITCODE }",
		reportCwd,
		"if ($__pi_ok) { exit 0 }",
		"if ($null -ne $__pi_native -and [int]$__pi_native -ne 0) { exit [int]$__pi_native }",
		"exit 1",
	]
		.filter(Boolean)
		.join("\n");
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Terminate a process tree through the trusted absolute System32 utility. */
export function killProcessTree(pid: number, env: NodeJS.ProcessEnv = process.env): void {
	const executable = taskkillExecutable(env);
	const result = spawnSync(executable, ["/PID", String(pid), "/T", "/F"], {
		encoding: "utf8",
		windowsHide: true,
	});
	if (result.status !== 0 && isProcessRunning(pid)) {
		const detail = (result.stderr || result.stdout || result.error?.message || `status ${result.status}`).trim();
		throw new Error(`Failed to terminate process tree ${pid}: ${detail}`);
	}
}
