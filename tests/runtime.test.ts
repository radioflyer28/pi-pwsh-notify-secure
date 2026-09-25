import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, { interopDefault: true });
const { buildPowerShellScript, powerShellArguments } = jiti(
	fileURLToPath(new URL("../src/runtime.ts", import.meta.url)),
);

test("runtime launch arguments use a fixed stdin bootstrap without policy overrides", () => {
	const args: string[] = powerShellArguments();
	assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
	assert.equal(args.length, 4);
	assert.match(args[3], /ReadToEnd/);
	assert.doesNotMatch(args.join(" "), /ExecutionPolicy|Bypass/i);
});

test("generated scripts preserve command source and capture final status and cwd", () => {
	const command = `$json = '{"message":"it''s nested"}'; Write-Output $json`;
	const script: string = buildPowerShellScript(command, "marker'");
	assert.match(script, /it''s nested/);
	assert.match(script, /marker''/);
	assert.match(script, /__pi_native/);
	assert.match(script, /exit 1/);
});
