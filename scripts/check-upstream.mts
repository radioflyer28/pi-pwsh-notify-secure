import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = "v0.5.0";
const baselineCommit = "4a7a48a03e3db3a6d7da901c5d0db1668560be85";

function git(...args) {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	if (result.error || result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr?.trim() || result.error || result.status}`);
	}
	return result.stdout.trim();
}

try {
	if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--fetch")) {
		throw new Error("Usage: node scripts/check-upstream.mts [--fetch]");
	}
	if (process.argv[2] === "--fetch") git("fetch", "upstream", "--tags");
	const tag = git("rev-parse", "--verify", `refs/tags/${baseline}^{commit}`);
	if (tag !== baselineCommit) {
		throw new Error(`${baseline} moved: expected ${baselineCommit}, got ${tag}. Inspect before syncing.`);
	}
	const head = git("rev-parse", "--verify", "refs/remotes/upstream/main^{commit}");
	if (git("merge-base", tag, head) !== tag) {
		throw new Error(`upstream/main (${head}) no longer descends from ${baseline} (${tag}). Review history manually.`);
	}
	const count = Number(git("rev-list", "--count", `${tag}..${head}`));
	console.log(`Reviewed upstream baseline: ${baseline} (${tag})`);
	console.log(`Fetched upstream/main: ${head}`);
	if (count) {
		console.error(`${count} upstream commit(s) need review:\n${git("log", "--oneline", `${tag}..${head}`)}`);
		process.exitCode = 1;
	} else {
		console.log("No upstream commits beyond the reviewed baseline.");
	}
} catch (error) {
	console.error(`Upstream check failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 2;
}
