import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const indexSource = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

test("the hardened git package cannot be published to npm accidentally", () => {
	assert.equal(packageJson.private, true);
	assert.equal(packageJson.publishConfig, undefined);
});

test("Pi 0.84.3 dependencies and TypeBox import are declared consistently", () => {
	assert.equal(packageJson.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.84.3");
	assert.equal(packageJson.peerDependencies["@earendil-works/pi-tui"], ">=0.84.3");
	assert.equal(packageJson.peerDependencies.typebox, "^1.3.7");
	assert.equal(packageJson.peerDependencies["@sinclair/typebox"], undefined);
	assert.match(indexSource, /from "typebox"/);
	assert.doesNotMatch(indexSource, /@sinclair\/typebox/);
});

test("release metadata and installation instructions use secure.2", () => {
	assert.equal(packageJson.version, "0.4.2-secure.2");
	assert.match(readme, /pi-pwsh-notify-secure@v0\.4\.2-secure\.2/);
	assert.doesNotMatch(readme, /secure\.1/);
});
