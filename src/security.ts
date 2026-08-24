import { existsSync } from "node:fs";
import { win32 } from "node:path";

type Environment = NodeJS.ProcessEnv;
type FileExists = (path: string) => boolean;

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
	return [...new Set(paths.map((path) => win32.normalize(path)))];
}

/**
 * Resolve the Windows directory without ever consulting the process cwd.
 * A malformed relative SystemRoot/WINDIR is ignored rather than resolved.
 */
export function windowsDirectory(env: Environment = process.env): string {
	for (const candidate of [env.SystemRoot, env.WINDIR]) {
		if (candidate) {
			const directory = unquote(candidate);
			if (win32.isAbsolute(directory)) return win32.normalize(directory);
		}
	}
	return String.raw`C:\Windows`;
}

/**
 * Find PowerShell using only absolute candidates. Relative and empty PATH
 * entries are intentionally ignored because Windows treats them as cwd-based.
 */
export function findPowerShellExecutable(
	env: Environment = process.env,
	fileExists: FileExists = existsSync,
): string {
	const pathDirectories = absoluteDirectories(env.Path ?? env.PATH);
	const programRoots = unique(
		[env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]]
			.filter((entry): entry is string => Boolean(entry))
			.map(unquote)
			.filter((entry) => win32.isAbsolute(entry)),
	);
	const systemRoot = windowsDirectory(env);

	// Prefer PowerShell 7, first in its standard location and then in absolute
	// PATH entries (which also covers winget, Scoop, and custom installations).
	const pwshCandidates = unique([
		...programRoots.map((root) => win32.join(root, "PowerShell", "7", "pwsh.exe")),
		...pathDirectories.map((directory) => win32.join(directory, "pwsh.exe")),
	]);
	for (const candidate of pwshCandidates) {
		if (fileExists(candidate)) return candidate;
	}

	// Windows PowerShell's system location is safer than an arbitrary PATH
	// entry and is the documented fallback when PowerShell 7 is unavailable.
	const powershellCandidates = unique([
		win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		...pathDirectories.map((directory) => win32.join(directory, "powershell.exe")),
	]);
	for (const candidate of powershellCandidates) {
		if (fileExists(candidate)) return candidate;
	}

	throw new Error("Neither PowerShell 7 nor Windows PowerShell was found at a trusted absolute path");
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

/** -EncodedCommand keeps arbitrary quoting intact (no arg-string reparsing). */
export function shellArgs(script: string): string[] {
	return [
		"-NoProfile",
		"-NonInteractive",
		"-EncodedCommand",
		Buffer.from(script, "utf16le").toString("base64"),
	];
}
