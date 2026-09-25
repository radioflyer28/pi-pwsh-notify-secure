/**
 * Keep a single model-facing shell surface. When the secure runtime is active,
 * this extension supersedes Pi's bash and native powershell tools. When it is
 * unavailable, the extension tools are hidden and Pi's built-ins remain.
 */
export function activeToolsForPowerShell(active: readonly string[], runtimeAvailable: boolean): string[] {
	if (!runtimeAvailable) return active.filter((tool) => tool !== "pwsh" && tool !== "pwsh_job");
	const hide = new Set(["bash", "powershell"]);
	if (active.includes("ffgrep") || active.includes("fffind")) {
		hide.add("grep");
		hide.add("find");
	}
	return active.filter((tool) => !hide.has(tool));
}

/** Compatibility helper for the active-runtime case. */
export function activeToolsWithPwsh(active: readonly string[]): string[] {
	return activeToolsForPowerShell(active, true);
}
