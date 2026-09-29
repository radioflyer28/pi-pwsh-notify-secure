import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

const jiti = createRequire(import.meta.url)("jiti")(import.meta.url, { interopDefault: true });
const { OutputTail, CwdFilter, outputUpdates, timeoutMilliseconds, startExecution, executionFailed,
  OUTPUT_MAX_CHARS, MAX_TIMEOUT_MS, EXIT_IDLE_MS } = jiti(fileURLToPath(new URL("../src/execution.ts", import.meta.url)));

function fake(options: Record<string, unknown> = {}, kill?: () => void) {
  const proc = Object.assign(new EventEmitter(), {
    pid: 1234, stdout: new PassThrough(), stderr: new PassThrough(),
  });
  let kills = 0;
  const execution = startExecution({ executable: "trusted", command: "test", cwd: ".", env: {}, ...options }, {
    spawn: () => proc,
    kill: () => { kills++; if (kill) kill(); else proc.emit("close", 1, null); },
  });
  return { proc, execution, get kills() { return kills; } };
}

test("timeouts: zero unlimited, fractions, maximum, invalid values rejected before spawn", () => {
  assert.equal(timeoutMilliseconds(undefined), undefined);
  assert.equal(timeoutMilliseconds(undefined, 120), 120_000);
  assert.equal(timeoutMilliseconds(0), undefined);
  assert.equal(timeoutMilliseconds(0.0001), 1);
  assert.equal(timeoutMilliseconds(MAX_TIMEOUT_MS / 1000), MAX_TIMEOUT_MS);
  for (const timeout of [-1, NaN, Infinity, -Infinity, MAX_TIMEOUT_MS / 1000 + 0.001]) {
    let spawns = 0;
    assert.throws(() => startExecution({ executable: "x", command: "", cwd: ".", env: {}, timeout }, {
      spawn: () => { spawns++; }, kill() {},
    }), /Invalid timeout/);
    assert.equal(spawns, 0);
  }
});

test("output tail stress: 256 MiB UTF-8-equivalent feed stays bounded and preserves Unicode tail", () => {
  const output = new OutputTail();
  const chunk = "🌍".repeat(32_768);
  for (let i = 0; i < 2048; i++) {
    output.append(chunk);
    assert.ok(output.text.length <= OUTPUT_MAX_CHARS);
    assert.doesNotMatch(output.text, /^[\uDC00-\uDFFF]/);
  }
  assert.equal(output.text.length + output.droppedChars, chunk.length * 2048);
  assert.ok(output.droppedChars > 100_000_000);
  output.append("FINAL");
  assert.ok(output.text.endsWith("FINAL"));
});

test("cwd control parsing survives split markers and retention rollover without leaking metadata", () => {
  const tail = new OutputTail(100);
  const filter = new CwdFilter("\x01cwd:", (text: string) => tail.append(text));
  for (const char of "prefix\x01cwd:C:\\work\n") filter.write(char);
  filter.write("x".repeat(10_000));
  filter.write("", true);
  assert.equal(filter.cwd, "C:\\work");
  assert.equal(tail.text.length, 100);
  assert.doesNotMatch(tail.text, /cwd/);
});

test("updates coalesce bursts, flush final dirty state exactly once, and stop", async () => {
  const values: number[] = [];
  let value = 0;
  const updates = outputUpdates(() => values.push(value), 100);
  for (; value < 10_000; value++) updates.mark();
  assert.deepEqual(values, [0]);
  updates.finish();
  assert.deepEqual(values, [0, 10_000]);
  updates.mark();
  updates.finish();
  await sleep(120);
  assert.equal(values.length, 2);
});

test("shared runner keeps stdout/stderr UTF-8 and CRLF decoder states independent", async () => {
  const { proc, execution } = fake();
  proc.stdout.write(Buffer.from("a\r"));
  proc.stderr.write(Buffer.from("err\n"));
  proc.stdout.write(Buffer.from("\nb"));
  for (const byte of Buffer.from("🌍")) proc.stdout.write(Buffer.from([byte]));
  proc.emit("close", 0, null);
  assert.equal((await execution.done).exitCode, 0);
  assert.equal(execution.output.text, "a\nerr\nb🌍");
});

test("quiet inherited handles settle after exit without requiring close", async () => {
  const { proc, execution } = fake();
  proc.stdout.write("before-exit");
  const start = Date.now();
  proc.emit("exit", 0, null);
  const result = await execution.done;
  assert.ok(Date.now() - start >= EXIT_IDLE_MS - 20);
  assert.ok(Date.now() - start < 2000);
  assert.equal(result.outputIncomplete, true);
  assert.equal(result.exitCode, 0);
  assert.equal(execution.output.text, "before-exit");
  assert.equal(proc.listenerCount("exit"), 0);
  assert.equal(proc.stdout.listenerCount("data"), 0);
});

test("late output re-arms post-exit idle grace instead of losing an active tail", async () => {
  const { proc, execution } = fake();
  let done = false;
  execution.done.then(() => { done = true; });
  proc.emit("exit", 0, null);
  for (let i = 0; i < 5; i++) {
    await sleep(80);
    assert.equal(done, false);
    proc.stdout.write(`late-${i}\n`);
  }
  proc.stdout.end("final\n");
  proc.stderr.end();
  const result = await execution.done;
  assert.equal(result.outputIncomplete, false);
  assert.match(execution.output.text, /late-4\nfinal/);
});

test("already-aborted requests never spawn; live abort is a failure and clears its timeout", async () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => fake({ signal: controller.signal }), /aborted before launch/);
  const live = new AbortController();
  const { execution, proc } = fake({ signal: live.signal, timeout: 10 });
  proc.stdout.write("retained");
  live.abort();
  const result = await execution.done;
  assert.equal(result.aborted, true);
  assert.equal(executionFailed(result), true);
  assert.equal(execution.output.text, "retained");
});

test("timeout cleanup failures settle explicitly with retained output rather than hang", async () => {
  const { proc, execution } = fake({ timeout: 0.02 }, () => { throw new Error("injected taskkill failure"); });
  proc.stderr.write("diagnostic");
  // Keep a referenced timer while the intentionally unref'ed execution timeout fires.
  const [result] = await Promise.all([execution.done, sleep(60)]);
  assert.equal(result.timedOut, true);
  assert.match(result.cleanupError, /injected taskkill failure/);
  assert.equal(executionFailed(result), true);
  assert.equal(execution.output.text, "diagnostic");
});

test("timeout and abort still settle active descendant pipes after parent exit without killing a stale PID", async () => {
  for (const mode of ["timeout", "abort", "stop"]) {
    const controller = new AbortController();
    const instance = fake({ timeout: mode === "timeout" ? 0.06 : 0, signal: controller.signal });
    instance.proc.emit("exit", 0, null);
    const writer = setInterval(() => instance.proc.stdout.write("late\n"), 10);
    const trigger = setTimeout(() => {
      if (mode === "abort") controller.abort();
      if (mode === "stop") instance.execution.stop();
    }, 40);
    try {
      const result = await instance.execution.done;
      assert.equal(result.outputIncomplete, true);
      assert.equal(result.timedOut, mode === "timeout");
      assert.equal(result.aborted, mode === "abort");
      assert.equal(instance.kills, 0, "parent PID must not be reused as a cleanup target after exit");
    } finally { clearInterval(writer); clearTimeout(trigger); }
  }
});

test("retrying cleanup does not target a PID whose failed-cleanup process has since exited", async () => {
  const instance = fake({ timeout: 0.01 }, () => { throw new Error("cleanup unavailable"); });
  const [result] = await Promise.all([instance.execution.done, sleep(40)]);
  assert.match(result.cleanupError, /cleanup unavailable/);
  assert.equal(instance.kills, 1);
  Object.assign(instance.proc, { exitCode: 0 });
  instance.execution.stop();
  assert.equal(instance.kills, 1);
});

test("spawn failure and signal-only exit cannot masquerade as success", async () => {
  const failed = fake();
  failed.proc.emit("error", new Error("spawn test failure"));
  const result = await failed.execution.done;
  assert.match(result.spawnError, /spawn test failure/);
  assert.equal(executionFailed(result), true);
  const signaled = fake();
  signaled.proc.emit("close", null, "SIGTERM");
  const stopped = await signaled.execution.done;
  assert.equal(stopped.signal, "SIGTERM");
  assert.equal(executionFailed(stopped), true);
});
