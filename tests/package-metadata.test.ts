import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const indexSource = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const research = await readFile(new URL("../docs/research/pi-0.84.3-native-powershell.md", import.meta.url), "utf8");

test("the hardened git package cannot be published to npm accidentally", () => {
	assert.equal(packageJson.private, true);
	assert.equal(packageJson.publishConfig, undefined);
});

test("Pi peer floor, Pi 0.87.1 development versions, and TypeBox import are consistent", () => {
	assert.equal(packageJson.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.84.3");
	assert.equal(packageJson.peerDependencies["@earendil-works/pi-tui"], ">=0.84.3");
	assert.equal(packageJson.devDependencies["@earendil-works/pi-coding-agent"], "0.87.1");
	assert.equal(packageJson.devDependencies["@earendil-works/pi-tui"], "0.87.1");
	assert.equal(packageJson.peerDependencies.typebox, "^1.3.7");
	assert.equal(packageJson.peerDependencies["@sinclair/typebox"], undefined);
	assert.match(indexSource, /from "typebox"/);
	assert.doesNotMatch(indexSource, /@sinclair\/typebox/);
});

test("release metadata and installation instructions use 0.5.0-secure.2", () => {
	assert.equal(packageJson.version, "0.5.0-secure.2");
	assert.match(readme, /pi-pwsh-notify-secure@v0\.5\.0-secure\.2/);
});

test("documentation records the secure upstream adaptation and compatibility behavior", () => {
	assert.match(readme, /BOM-less UTF-8 over stdin/);
	assert.match(readme, /metadata only/);
	assert.match(readme, /not written to temporary or persistent log files by default/);
	assert.match(readme, /`!` and `!!` editor shortcuts execute through the same trusted PowerShell runtime/);
	assert.match(readme, /Pi\/TUI 0\.87\.1/);
	assert.match(research, /selectively ports upstream `pi-pwsh-notify` 0\.5\.0 reliability work/);
	assert.match(research, /creates no default complete-output logs/);
});
