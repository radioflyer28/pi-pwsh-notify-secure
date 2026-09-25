import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

type Environment = NodeJS.ProcessEnv;
type FileExists = (path: string) => boolean;

export const POWERSHELL_RUNTIME_ENV = "PI_PWSH_NOTIFY_EXECUTABLE";
const PROBE_TIMEOUT_MS = 5_000;

export interface PowerShellRuntime {
	executable: string;
	version: string;
	edition: "Core" | "Desktop";
	kind: "pwsh" | "windows-powershell";
}

export type RuntimeProbe = (executable: string, env: Environment) => PowerShellRuntime | undefined;

function unquote(value: string): string {
	const trimmed = value.trim();
	return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

function absoluteDirectories(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(win32.delimiter)
		.map(unquote)
		.filter((entry) => entry.length > 0 && win32.isAbsolute(entry))
		.map((entry) => win32.normalize(entry));
}

function unique(paths: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const path of paths) {
		const normalized = win32.normalize(path);
		const key = normalized.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(normalized);
	}
	return result;
}

/**
 * Resolve the Windows directory without ever consulting the process cwd.
 * A malformed relative SystemRoot/WINDIR is ignored rather than resolved.
 */
export function windowsDirectory(env: Environment = process.env): string {
	for (const candidate of [env.SystemRoot, env.WINDIR]) {
		if (!candidate) continue;
		const directory = unquote(candidate);
		if (win32.isAbsolute(directory)) return win32.normalize(directory);
	}
	return String.raw`C:\Windows`;
}

/** Enumerate only absolute PowerShell candidates, in preference order. */
export function powerShellCandidates(env: Environment = process.env): string[] {
	const explicitValue = env[POWERSHELL_RUNTIME_ENV]?.trim();
	if (explicitValue) {
		const explicit = unquote(explicitValue);
		if (!win32.isAbsolute(explicit)) {
			throw new Error(`${POWERSHELL_RUNTIME_ENV} must be an absolute Windows path: ${explicitValue}`);
		}
		return [win32.normalize(explicit)];
	}

	const pathDirectories = absoluteDirectories(env.Path ?? env.PATH);
	const programRoots = unique(
		[env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]]
			.filter((entry): entry is string => Boolean(entry))
			.map(unquote)
			.filter((entry) => win32.isAbsolute(entry)),
	);
	const systemRoot = windowsDirectory(env);

	return unique([
		...programRoots.map((root) => win32.join(root, "PowerShell", "7", "pwsh.exe")),
		...pathDirectories.map((directory) => win32.join(directory, "pwsh.exe")),
		win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		...pathDirectories.map((directory) => win32.join(directory, "powershell.exe")),
	]);
}

export function probePowerShellRuntime(executable: string, env: Environment = process.env): PowerShellRuntime | undefined {
	if (!win32.isAbsolute(executable)) return undefined;
	const script =
		"[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); " +
		"Write-Output ($PSVersionTable.PSEdition + '|' + $PSVersionTable.PSVersion.Major + '|' + $PSVersionTable.PSVersion.ToString())";
	const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf8",
		env,
		timeout: PROBE_TIMEOUT_MS,
		windowsHide: true,
	});
	if (result.status !== 0 || result.error) return undefined;
	const line = result.stdout.trim().split(/\r?\n/).at(-1) ?? "";
	const [editionText, majorText, version] = line.split("|");
	const major = Number(majorText);
	const edition = editionText === "Core" ? "Core" : editionText === "Desktop" ? "Desktop" : undefined;
	if (!edition || !Number.isInteger(major) || !version) return undefined;
	if (edition === "Core" && major < 7) return undefined;
	if (edition === "Desktop" && major < 5) return undefined;
	return {
		executable: win32.normalize(executable),
		version,
		edition,
		kind: edition === "Core" ? "pwsh" : "windows-powershell",
	};
}

/** Resolve and probe a supported runtime without unqualified discovery commands. */
export function findPowerShellRuntime(
	env: Environment = process.env,
	fileExists: FileExists = existsSync,
	probe: RuntimeProbe = probePowerShellRuntime,
): PowerShellRuntime {
	for (const candidate of powerShellCandidates(env)) {
		if (!fileExists(candidate)) continue;
		const runtime = probe(candidate, env);
		if (runtime) return runtime;
	}
	const configured = env[POWERSHELL_RUNTIME_ENV]?.trim();
	const hint = configured
		? `${POWERSHELL_RUNTIME_ENV} points to an unavailable or unsupported PowerShell: ${configured}`
		: "Install PowerShell 7 with: winget install Microsoft.PowerShell";
	throw new Error(`No supported PowerShell runtime was found at a trusted absolute path. ${hint}`);
}

/** Resolve taskkill from the Windows system directory, never from cwd/PATH. */
export function taskkillExecutable(
	env: Environment = process.env,
	fileExists: FileExists = existsSync,
): string {
	const candidate = win32.join(windowsDirectory(env), "System32", "taskkill.exe");
	if (!fileExists(candidate)) {
		throw new Error(`Windows taskkill.exe was not found at the trusted system path: ${candidate}`);
	}
	return candidate;
}
