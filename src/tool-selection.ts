/**
 * Keep a single model-facing shell surface. This extension supersedes both
 * Pi's legacy bash tool and Pi 0.84.3's optional native powershell tool.
 */
export function activeToolsWithPwsh(active: readonly string[]): string[] {
	const hide = new Set(["bash", "powershell"]);
	if (active.includes("ffgrep") || active.includes("fffind")) {
		hide.add("grep");
		hide.add("find");
	}
	return active.filter((tool) => !hide.has(tool));
}
