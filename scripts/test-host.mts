import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// Isolate host versions; never mutate repo node_modules, lockfile, installed Pi, or npm age policy.
const versions = ["0.84.3", "0.87.1", "0.99.1"];
const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
const version = args.includes("--version") ? option("--version") : "0.99.1";
if (!versions.includes(version)) throw new Error(`Expected --version ${versions.join(" | ")}`);
const repo = fileURLToPath(new URL("..", import.meta.url));
const sandbox = await mkdtemp(join(tmpdir(), `pwsh-host-${version}-`));
const fixture = join(sandbox, "host");
await mkdir(fixture);
const run = (command: string, argv: string[], cwd: string) => {
	const r = spawnSync(command, argv, { cwd, stdio: "inherit", shell: process.platform === "win32" && command === "npm" });
	if (r.error) throw r.error;
	if (r.status !== 0) throw new Error(`${command} ${argv.join(" ")} failed (${r.status})`);
};
let host: string;
let tui: string;
if (args.includes("--installed")) {
	host = resolve(option("--installed"));
	tui = join(host, "node_modules/@earendil-works/pi-tui");
} else {
	await writeFile(join(fixture, "package.json"), JSON.stringify({ private: true, dependencies: {
		"@earendil-works/pi-coding-agent": version, "@earendil-works/pi-tui": version,
	}, overrides: {
		"@earendil-works/pi-tui": version, "@earendil-works/pi-agent-core": version, "@earendil-works/pi-ai": version,
	} }, null, 2));
	// Optional saved fixture lock enables exact replay of every transitive dependency.
	if (args.includes("--lock")) await cp(resolve(option("--lock")), join(fixture, "package-lock.json"));
	run("npm", [args.includes("--lock") ? "ci" : "install", "--ignore-scripts", "--no-audit", "--no-fund"], fixture);
	host = join(fixture, "node_modules/@earendil-works/pi-coding-agent");
	// Pi tarballs bundle their own TUI. Share that physical instance, not a duplicate registry.
	const bundledTui = join(host, "node_modules/@earendil-works/pi-tui");
	tui = existsSync(bundledTui) ? bundledTui : join(fixture, "node_modules/@earendil-works/pi-tui");
}
for (const directory of [host, tui]) {
	const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
	if (pkg.version !== version) throw new Error(`${pkg.name}: expected ${version}, got ${pkg.version}`);
}
const work = join(sandbox, "package");
await mkdir(work);
for (const path of ["src", "tests", "test", "docs", "README.md", "package.json", "tsconfig.json"]) {
	await cp(join(repo, path), join(work, path), { recursive: true });
}
const links: Record<string, string> = {
	"@earendil-works/pi-coding-agent": host, "@earendil-works/pi-tui": tui,
	"jiti": join(repo, "node_modules/jiti"), "typebox": join(repo, "node_modules/typebox"),
	"@types/node": join(repo, "node_modules/@types/node"),
};
for (const [name, target] of Object.entries(links)) {
	const destination = join(work, "node_modules", name);
	await mkdir(dirname(destination), { recursive: true });
	await symlink(target, destination, process.platform === "win32" ? "junction" : "dir");
}
const evidence = { version, mode: args.includes("--installed") ? "installed-host-smoke" : "pinned-fixture",
	host, tui, node: process.version, repoLockSha256: createHash("sha256").update(await readFile(join(repo, "package-lock.json"))).digest("hex"), sandbox };
await writeFile(join(sandbox, "evidence.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
if (args.includes("--artifacts")) {
	const destination = resolve(option("--artifacts"));
	await mkdir(destination, { recursive: true });
	await cp(join(sandbox, "evidence.json"), join(destination, "evidence.json"));
	if (existsSync(join(fixture, "package-lock.json"))) await cp(join(fixture, "package-lock.json"), join(destination, "host-package-lock.json"));
}
// Keep sandbox + dependency lock for diagnosis and exact replay; no best-effort cleanup hiding failures.
run(process.execPath, [join(repo, "node_modules/typescript/bin/tsc"), "--noEmit", "--project", join(work, "tsconfig.json")], work);
run(process.execPath, ["--experimental-strip-types", "--test", "tests/*.test.ts"], work);
run(process.execPath, ["--experimental-strip-types", "--test", "test/run-tests.mts", "test/codemode.test.mts"], work);
console.log(`HOST ${version}: all checks passed; artifacts: ${sandbox}`);
