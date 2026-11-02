import assert from "node:assert/strict";
import test from "node:test";
import { win32 } from "node:path";
import { AUTOMATED_NOTE, jobNotificationMetadata } from "../src/notifications.ts";
import {
	findPowerShellRuntime,
	powerShellCandidates,
	probePowerShellRuntime,
	taskkillExecutable,
	windowsDirectory,
} from "../src/security.ts";
import { activeToolsForPowerShell, activeToolsWithPwsh } from "../src/tool-selection.ts";

test("PowerShell resolution ignores cwd-relative and empty PATH entries", () => {
	const attempted: string[] = [];
	const expected = String.raw`C:\Tools\PowerShell\pwsh.exe`;
	const resolved = findPowerShellRuntime(
		{ Path: String.raw`;.;relative\bin;\rooted;C:drive-relative;\\server\share;C:\Tools\PowerShell`, SystemRoot: String.raw`C:\Windows` },
		(executable) => {
			attempted.push(executable);
			return executable === expected ? { executable, version: "7.5.0", edition: "Core", kind: "pwsh" } : undefined;
		},
	);
	assert.equal(resolved.executable, expected);
	assert.deepEqual(attempted, [expected]);
});

test("PowerShell 7 is preferred over Windows PowerShell", () => {
	const pwsh = String.raw`C:\Program Files\PowerShell\7\pwsh.exe`;
	const resolved = findPowerShellRuntime(
		{ ProgramFiles: String.raw`C:\Program Files`, SystemRoot: String.raw`C:\Windows` },
		(executable) => executable === pwsh
			? { executable, version: "7.5.0", edition: "Core", kind: "pwsh" }
			: { executable, version: "5.1", edition: "Desktop", kind: "windows-powershell" },
	);
	assert.equal(resolved.executable, pwsh);
});

test("a Store alias reaches the probe without a filesystem existence gate", () => {
	const alias = String.raw`C:\StoreOnly\Microsoft\WindowsApps\pwsh.exe`;
	const env = { LOCALAPPDATA: String.raw`C:\StoreOnly`, SystemRoot: String.raw`C:\Windows` };
	const probed: string[] = [];
	const resolved = findPowerShellRuntime(env, (executable, actualEnv) => {
		assert.equal(actualEnv, env);
		probed.push(executable);
		return executable === alias ? { executable, version: "7.5.0", edition: "Core", kind: "pwsh" } : undefined;
	});
	assert.equal(resolved.executable, alias);
	assert.deepEqual(probed, [alias]);
	assert.equal(findPowerShellRuntime({ PI_PWSH_NOTIFY_EXECUTABLE: alias }, () => resolved), resolved);
});

test("a missing or unsupported candidate cannot prevent the Windows PowerShell fallback", () => {
	const expected = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
	const probed: string[] = [];
	const runtime = findPowerShellRuntime({ ProgramFiles: String.raw`C:\Missing` }, (executable) => {
		probed.push(executable);
		return executable === expected ? { executable, version: "5.1", edition: "Desktop", kind: "windows-powershell" } : undefined;
	});
	assert.equal(runtime.executable, expected);
	assert.deepEqual(probed, [String.raw`C:\Missing\PowerShell\7\pwsh.exe`, expected]);
	assert.throws(() => findPowerShellRuntime({ PI_PWSH_NOTIFY_EXECUTABLE: String.raw`C:\Missing\pwsh.exe` }, () => undefined), /unavailable or unsupported/);
});

test("overrides require a full drive or UNC path, not a current-drive root or device namespace", () => {
	for (const value of ["pwsh.exe", String.raw`.\pwsh.exe`, String.raw`\tools\pwsh.exe`, "/tools/pwsh.exe", "C:pwsh.exe", '""', String.raw`\\server`, String.raw`\\.\pipe\pwsh`, String.raw`\\?\C:\pwsh.exe`]) {
		assert.throws(() => powerShellCandidates({ PI_PWSH_NOTIFY_EXECUTABLE: value }), /must be an absolute Windows path/, value);
		let launches = 0;
		assert.equal(probePowerShellRuntime(value, {}, () => { launches++; throw new Error("must not launch"); }), undefined);
		assert.equal(launches, 0);
	}
	for (const value of [String.raw`C:\Tools\pwsh.exe`, "D:/Tools/pwsh.exe", String.raw`\\server\share\pwsh.exe`, "//server/share/pwsh.exe"]) {
		assert.deepEqual(powerShellCandidates({ PI_PWSH_NOTIFY_EXECUTABLE: value }), [win32.normalize(value)]);
	}
});

test("implicit discovery is local-drive-only and deduplicates quoted Store PATH entries", () => {
	const candidates = powerShellCandidates({
		Path: String.raw`;.;relative\bin;\tools;/tools;C:tools;\\server\share;"C:\Local\Microsoft\WindowsApps"`,
		ProgramFiles: String.raw`\rooted`, ProgramW6432: String.raw`\\server\share`,
		LOCALAPPDATA: String.raw`C:\Local`, SystemRoot: String.raw`\Windows`, WINDIR: String.raw`D:\Windows`,
	});
	assert.deepEqual(candidates, [String.raw`C:\Local\Microsoft\WindowsApps\pwsh.exe`, String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, String.raw`C:\Local\Microsoft\WindowsApps\powershell.exe`]);
	assert.ok(candidates.every(path => /^[a-z]:[\\/]/i.test(path)));
	assert.equal(windowsDirectory({ SystemRoot: String.raw`\Windows`, WINDIR: "C:Windows" }), String.raw`C:\Windows`);
	assert.equal(taskkillExecutable({ SystemRoot: String.raw`\Windows`, WINDIR: String.raw`D:\Windows` }, () => true), String.raw`D:\Windows\System32\taskkill.exe`);
});

test("the bounded probe uses the executable directory and preserves the no-Bypass policy", () => {
	const executable = String.raw`C:\Trusted\pwsh.exe`;
	const env = { Path: String.raw`C:\Trusted` };
	const runtime = probePowerShellRuntime(executable, env, (file, args, options) => {
		assert.equal(file, executable);
		assert.equal(options.cwd, String.raw`C:\Trusted`);
		assert.equal(options.env, env);
		assert.equal(options.timeout, 5000);
		assert.equal(options.windowsHide, true);
		assert.doesNotMatch(args.join(" "), /ExecutionPolicy|Bypass/);
		return { pid: 1, status: 0, signal: null, stdout: "Core|7|7.5.0\n", stderr: "", output: [null, "Core|7|7.5.0\n", ""] };
	});
	assert.deepEqual(runtime, { executable, version: "7.5.0", edition: "Core", kind: "pwsh" });
});

test("taskkill is resolved only from System32", () => {
	const expected = String.raw`D:\Windows\System32\taskkill.exe`;
	assert.equal(taskkillExecutable({ SystemRoot: String.raw`D:\Windows`, Path: String.raw`. ; C:\malicious` }, (p) => p === expected), expected);
});

test("automatic notifications contain metadata but no command or process output", () => {
	const notification = jobNotificationMetadata("background-job-finished", "bg-1", "exited 1", "3s");
	assert.equal(notification, '<background-job-finished id="bg-1" status="exited 1" runtime="3s" />');
	assert.match(AUTOMATED_NOTE, /metadata-only/);
	assert.match(AUTOMATED_NOTE, /untrusted data/);
	assert.doesNotMatch(notification, /Command:|output tail|upload|OPENAI_API_KEY/i);
});

test("notification metadata escapes attribute values", () => {
	const notification = jobNotificationMetadata("background-job-ready", 'bg-1" command="evil', "ready", "1s");
	assert.equal(
		notification,
		'<background-job-ready id="bg-1&quot; command=&quot;evil" status="ready" runtime="1s" />',
	);
});

test("shell pruning preserves resolved additive, subtractive, and explicit tool selections", () => {
	// Inputs are host-resolved active names, never raw CLI +name/-name expressions.
	for (const selected of [
		["read", "edit", "bash", "powershell", "pwsh", "pwsh_job", "codemode"],
		["read", "codemode", "pwsh"],
		["read", "codemode"],
		[],
	]) {
		const before = [...selected];
		const active = activeToolsForPowerShell(selected, true);
		assert.deepEqual(active, selected.filter(name => !["bash", "powershell"].includes(name)));
		assert.deepEqual(selected, before);
		assert.ok(!active.includes("write"), "must not restore a subtracted tool");
		assert.deepEqual(activeToolsForPowerShell(active, true), active, "reload is idempotent");
		assert.deepEqual(activeToolsForPowerShell(selected, false), selected.filter(name => !["pwsh", "pwsh_job"].includes(name)));
	}
});

test("the extension removes both built-in shell tools", () => {
	assert.deepEqual(
		activeToolsWithPwsh(["read", "bash", "powershell", "pwsh", "pwsh_job", "edit", "write"]),
		["read", "pwsh", "pwsh_job", "edit", "write"],
	);
});

test("grep and find remain available unless pi-fff replaces them", () => {
	assert.deepEqual(activeToolsWithPwsh(["grep", "find", "read"]), ["grep", "find", "read"]);
	assert.deepEqual(activeToolsWithPwsh(["grep", "find", "ffgrep", "read"]), ["ffgrep", "read"]);
});

test("unavailable runtime hides extension tools and preserves Pi built-ins", () => {
	assert.deepEqual(
		activeToolsForPowerShell(["read", "bash", "powershell", "pwsh", "pwsh_job", "grep", "find"], false),
		["read", "bash", "powershell", "grep", "find"],
	);
});
