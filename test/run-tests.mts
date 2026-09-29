import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, wrapRegisteredTool } from "@earendil-works/pi-coding-agent";

process.setMaxListeners(100);

const REPO = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url, { interopDefault: true });
const extensionModule = jiti(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
const runtimeModule = jiti(fileURLToPath(new URL("../src/runtime.ts", import.meta.url)));
const pwshNotifyExtension = extensionModule.default ?? extensionModule;
const { buildPowerShellScript, resolvePowerShellRuntime, spawnPowerShell } = runtimeModule;

interface HarnessOptions {
  cwd?: string;
  sendFailures?: number;
}

function makeHarness(options: HarnessOptions = {}) {
  const tools = new Map<string, any>();
  const messages: Array<{ msg: any; opts: any }> = [];
  const eventHandlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  let activeTools = ["read", "bash", "powershell", "grep", "find"];
  let sendFailures = options.sendFailures ?? 0;
  let sendAttempts = 0;
  const ui = {
    setStatus() {},
    setWidget() {},
    onTerminalInput() { return () => {}; },
    getEditorText() { return ""; },
    notify() {},
    async custom() {},
  };
  const pi = {
    registerTool(definition: any) {
      tools.set(definition.name, definition);
      activeTools.push(definition.name);
    },
    registerMessageRenderer() {},
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(handler);
      eventHandlers.set(event, handlers);
    },
    sendMessage(msg: any, opts: any) {
      sendAttempts++;
      if (sendFailures-- > 0) throw new Error("injected send failure");
      messages.push({ msg, opts });
    },
    getActiveTools() { return [...activeTools]; },
    setActiveTools(next: string[]) { activeTools = [...next]; },
  };
  pwshNotifyExtension(pi);
  const ctx = {
    cwd: options.cwd ?? REPO,
    hasUI: false,
    mode: "rpc",
    ui,
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionFile: () => `${REPO}/test-session.jsonl`,
    },
    model: { provider: "test-provider", id: "test-model" },
    thinkingLevel: "high",
  };
  return {
    tools,
    messages,
    get activeTools() { return [...activeTools]; },
    get sendAttempts() { return sendAttempts; },
    fire(event: string, payload: any = { type: event }) {
      for (const handler of eventHandlers.get(event) ?? []) handler(payload, ctx);
    },
    async emit(event: string, payload: any = { type: event }) {
      const results = [];
      for (const handler of eventHandlers.get(event) ?? []) results.push(await handler(payload, ctx));
      return results;
    },
    call(tool: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (result: any) => void) {
      return tools.get(tool).execute("test-call", params, signal, onUpdate, ctx);
    },
    // Match AgentSession's afterToolCall contract: thrown execution is an error;
    // tool_result hooks may attach details but must not turn it back into success.
    async protocol(tool: string, params: Record<string, unknown>, signal?: AbortSignal) {
      let result: any;
      let isError = false;
      // Both public wrapper contracts are deliberately exercised by the host matrix.
      const contextFactory = { createContext: () => ctx, createToolContext: (_id: string, _signal?: AbortSignal) => ctx,
        getActiveTools: () => [...activeTools] };
      const wrapped = wrapRegisteredTool({ definition: tools.get(tool) } as any,
        contextFactory as unknown as Parameters<typeof wrapRegisteredTool>[1]);
      try { result = await wrapped.execute("protocol-call", params, signal); }
      catch (error) {
        isError = true;
        result = { content: [{ type: "text", text: (error as Error).message }], details: undefined };
      }
      for (const handler of eventHandlers.get("tool_result") ?? []) {
        const change = await handler({ type: "tool_result", toolName: tool, toolCallId: "protocol-call", input: params, ...result, isError }, ctx);
        if (change) result = { ...result, ...change as object };
      }
      return { ...result, isError };
    },
  };
}

const textOf = (result: any): string => result.content[0].text;

test("public wrapper mock satisfies the selected host contract before testing execution", async () => {
  const h = makeHarness();
  try {
    h.tools.set("probe", { name:"probe", label:"probe", description:"probe", parameters:{type:"object"},
      execute: async () => ({content:[{type:"text",text:"wrapper reached execute"}],details:{probe:true}}) });
    const result = await h.protocol("probe", {});
    assert.equal(result.isError, false, textOf(result));
    assert.equal(result.details?.probe, true);
  } finally { await h.emit("session_shutdown"); }
});

// Pure harness tests remain runnable on non-Windows CI.
test("integration harness loads the TypeScript extension through jiti", () => {
  const harness = makeHarness();
  assert.deepEqual([...harness.tools.keys()].sort(), ["pwsh", "pwsh_job"]);
});

test("integration harness observes secure active-tool pruning", () => {
  const harness = makeHarness();
  harness.fire("session_start");
  assert.ok(!harness.activeTools.includes("bash"));
  assert.ok(!harness.activeTools.includes("powershell"));
  assert.ok(harness.activeTools.includes("pwsh"));
  assert.ok(harness.activeTools.includes("pwsh_job"));
  harness.fire("session_shutdown");
});

test("runtime detection failure preserves Pi built-ins and hides extension tools", () => {
  const previous = process.env.PI_PWSH_NOTIFY_EXECUTABLE;
  process.env.PI_PWSH_NOTIFY_EXECUTABLE = String.raw`.\untrusted-relative-pwsh.exe`;
  try {
    const harness = makeHarness();
    harness.fire("session_start");
    assert.ok(harness.activeTools.includes("bash"));
    assert.ok(harness.activeTools.includes("powershell"));
    assert.ok(!harness.activeTools.includes("pwsh"));
    assert.ok(!harness.activeTools.includes("pwsh_job"));
    harness.fire("session_shutdown");
  } finally {
    if (previous === undefined) delete process.env.PI_PWSH_NOTIFY_EXECUTABLE;
    else process.env.PI_PWSH_NOTIFY_EXECUTABLE = previous;
  }
});

async function runRuntime(command: string): Promise<{ output: string; code: number | null }> {
  const runtime = resolvePowerShellRuntime();
  const proc = spawnPowerShell(runtime.executable, buildPowerShellScript(command), {
    cwd: REPO,
    env: process.env,
  });
  let output = "";
  proc.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  proc.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  const code = await new Promise<number | null>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", resolve);
  });
  return { output, code };
}

// Real-process coverage is explicitly Windows-only.
test("user shell: secure operations execute and persist cwd", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  harness.fire("session_start");
  const results = await harness.emit("user_bash", { command: "Write-Output shortcut", excludeFromContext: false });
  const operations = (results.find((result: any) => result?.operations) as any)?.operations;
  assert.ok(operations);
  const dir = (process.env.TEMP ?? REPO).replace(/\\$/, "");
  const escaped = dir.replaceAll("'", "''");
  let firstOutput = "";
  const first = await operations.exec(`Set-Location '${escaped}'; Write-Output shortcut`, REPO, {
    onData: (chunk: Buffer) => { firstOutput += chunk.toString("utf8"); },
    timeout: 5,
  });
  assert.equal(first.exitCode, 0);
  assert.match(firstOutput, /shortcut/);
  let secondOutput = "";
  await operations.exec("$PWD.Path", REPO, {
    onData: (chunk: Buffer) => { secondOutput += chunk.toString("utf8"); },
    timeout: 5,
  });
  assert.match(secondOutput, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  harness.fire("session_shutdown");
});

test("user shell: timeout and abort terminate commands", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  harness.fire("session_start");
  const results = await harness.emit("user_bash", { command: "", excludeFromContext: false });
  const operations = (results.find((result: any) => result?.operations) as any)?.operations;
  assert.ok(operations);
  const started = Date.now();
  let timeoutOutput = "";
  const timed = await operations.exec("Start-Sleep -Seconds 30", REPO, { onData(chunk: Buffer) { timeoutOutput += chunk.toString(); }, timeout: 0.5 });
  assert.notEqual(timed.exitCode, 0);
  assert.match(timeoutOutput, /timed out/);
  assert.ok(Date.now() - started < 5_000);
  const controller = new AbortController();
  const pending = operations.exec("Start-Sleep -Seconds 30", REPO, {
    onData() {},
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 500);
  const aborted = await pending;
  assert.notEqual(aborted.exitCode, 0);
  harness.fire("session_shutdown");
});

test("user shell: unavailable runtime propagates to Pi fallback", async () => {
  const previous = process.env.PI_PWSH_NOTIFY_EXECUTABLE;
  process.env.PI_PWSH_NOTIFY_EXECUTABLE = String.raw`.\untrusted-relative-pwsh.exe`;
  try {
    const harness = makeHarness();
    const results = await harness.emit("user_bash", { command: "Write-Output fallback", excludeFromContext: false });
    assert.ok(results.every((result) => result === undefined));
    harness.fire("session_shutdown");
  } finally {
    if (previous === undefined) delete process.env.PI_PWSH_NOTIFY_EXECUTABLE;
    else process.env.PI_PWSH_NOTIFY_EXECUTABLE = previous;
  }
});

test("windows runtime: stdin transports long command source", { skip: process.platform !== "win32" }, async () => {
  const payload = "x".repeat(40_000);
  const result = await runRuntime(`$value = '${payload}'\nWrite-Output $value.Length`);
  assert.equal(result.code, 0);
  assert.match(result.output, /40000/);
});

test("windows runtime: stdin preserves nested JSON and PowerShell quoting", { skip: process.platform !== "win32" }, async () => {
  const result = await runRuntime(`$value = '{"message":"it''s intact"}'\nWrite-Output $value`);
  assert.equal(result.code, 0);
  assert.match(result.output, /\{"message":"it's intact"\}/);
});

test("windows runtime: foreground PowerShell echo", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  const result = await harness.call("pwsh", { command: "Write-Output 'integration-ok'" });
  assert.match(textOf(result), /integration-ok/);
  harness.fire("session_shutdown");
});

test("windows runtime: foreground transports long source and UTF-8", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  const payload = "x".repeat(40_000);
  const result = await harness.call("pwsh", {
    command: `$value = '${payload}'\nWrite-Output $value.Length\nWrite-Output 'héllo 🌍'`,
  });
  assert.match(textOf(result), /40000/);
  assert.match(textOf(result), /héllo 🌍/);
  harness.fire("session_shutdown");
});

test("windows runtime: native and cmdlet exit outcomes are correct", { skip: process.platform !== "win32" }, async () => {
  const nativeHarness = makeHarness();
  const native = await nativeHarness.protocol("pwsh", { command: `cmd /c "exit 3"` });
  assert.equal(native.isError, true);
  assert.equal(native.details.exitCode, 3);
  assert.match(textOf(native), /exit code: 3/);
  nativeHarness.fire("session_shutdown");

  const cmdletHarness = makeHarness();
  const cmdlet = await cmdletHarness.protocol("pwsh", { command: "Get-Item 'C:\\definitely-missing-pi-pwsh-notify'" });
  assert.equal(cmdlet.isError, true);
  assert.equal(cmdlet.details.exitCode, 1);
  assert.match(textOf(cmdlet), /exit code: 1/);
  cmdletHarness.fire("session_shutdown");

  const recoveryHarness = makeHarness();
  const recovered = await recoveryHarness.call("pwsh", { command: `cmd /c "exit 3"; Write-Output recovered` });
  assert.match(textOf(recovered), /recovered/);
  assert.doesNotMatch(textOf(recovered), /exit code:/);
  recoveryHarness.fire("session_shutdown");
});

test("windows runtime: foreground exposes Pi environment", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  const result = await harness.call("pwsh", {
    command: 'Write-Output "$env:PI_PROVIDER/$env:PI_MODEL/$env:PI_SESSION_ID/$env:PI_REASONING_LEVEL"',
  });
  assert.match(textOf(result), /test-provider\/test-model\/test-session\/high/);
  harness.fire("session_shutdown");
});

test("windows runtime: foreground cwd persists and concurrent calls serialize", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  const dir = (process.env.TEMP ?? REPO).replace(/\\$/, "");
  const escaped = dir.replaceAll("'", "''");
  const [first, second] = await Promise.all([
    harness.call("pwsh", { command: `Set-Location '${escaped}'; Start-Sleep -Milliseconds 300; Write-Output moved` }),
    harness.call("pwsh", { command: "$PWD.Path" }),
  ]);
  assert.match(textOf(first), /moved/);
  assert.match(textOf(second), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  harness.fire("session_shutdown");
});

test("windows runtime: timeout and abort clean up foreground processes", { skip: process.platform !== "win32" }, async () => {
  const timeoutHarness = makeHarness();
  const timed = await timeoutHarness.protocol("pwsh", { command: "Start-Sleep -Seconds 30", timeout: 1 });
  assert.equal(timed.isError, true);
  assert.equal(timed.details.timedOut, true);
  assert.match(textOf(timed), /timed out/);
  timeoutHarness.fire("session_shutdown");

  const abortHarness = makeHarness();
  const controller = new AbortController();
  const pending = abortHarness.protocol("pwsh", { command: "Start-Sleep -Seconds 30" }, controller.signal);
  setTimeout(() => controller.abort(), 500);
  const aborted = await pending;
  assert.equal(aborted.isError, true);
  assert.equal(aborted.details.aborted, true);
  assert.match(textOf(aborted), /aborted/);
  abortHarness.fire("session_shutdown");
});

test("windows runtime: no output yields a placeholder", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  const result = await harness.call("pwsh", { command: "$null" });
  assert.match(textOf(result), /no output/);
  harness.fire("session_shutdown");
});

test("notifications: finished payload and renderer details remain metadata-only", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  harness.fire("session_start");
  await harness.call("pwsh", {
    command: "Write-Output 'OPENAI_API_KEY=secret-command-output'",
    run_in_background: true,
    name: "safe-label",
  });
  await sleep(1_800);
  const delivered = harness.messages.filter(({ msg }) => msg.customType === "pwsh-bg-notify");
  assert.ok(delivered.length > 0);
  const serialized = JSON.stringify(delivered);
  assert.match(serialized, /background-job-finished/);
  assert.match(serialized, /metadata-only/);
  assert.doesNotMatch(serialized, /OPENAI_API_KEY|secret-command-output|Full log|Matched:/i);
  assert.match(serialized, /safe-label/);
  harness.fire("session_shutdown");
});

test("notifications: ready payload omits matched output", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  harness.fire("session_start");
  await harness.call("pwsh", {
    command: "Write-Output 'READY SECRET_MATCH_VALUE'; Start-Sleep -Seconds 30",
    run_in_background: true,
    notify_on: "READY.*SECRET_MATCH_VALUE",
  });
  await sleep(1_500);
  const delivered = harness.messages.filter(({ msg }) => msg.customType === "pwsh-bg-notify");
  assert.ok(delivered.some(({ msg }) => msg.content.includes("background-job-ready")));
  assert.doesNotMatch(JSON.stringify(delivered), /SECRET_MATCH_VALUE|Write-Output|Matched:/i);
  await harness.call("pwsh_job", { action: "kill", id: "bg-1" });
  harness.fire("session_shutdown");
});

test("notifications: wait observing exit suppresses finished delivery", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  harness.fire("session_start");
  await harness.call("pwsh", { command: "Write-Output done", run_in_background: true });
  const result = await harness.call("pwsh_job", { action: "wait", id: "bg-1" });
  assert.match(textOf(result), /exited 0/);
  await sleep(500);
  assert.ok(!harness.messages.some(({ msg }) => msg.content?.includes("background-job-finished")));
  harness.fire("session_shutdown");
});

test("notifications: output after exit cancels queued finished delivery", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  harness.fire("session_start");
  await harness.call("pwsh", { command: "Start-Sleep -Milliseconds 100; Write-Output done", run_in_background: true });
  let result;
  for (let attempt = 0; attempt < 40; attempt++) {
    result = await harness.call("pwsh_job", { action: "output", id: "bg-1" });
    if (/exited 0/.test(textOf(result))) break;
    await sleep(25);
  }
  assert.match(textOf(result), /exited 0/);
  await sleep(500);
  assert.ok(!harness.messages.some(({ msg }) => msg.content?.includes("background-job-finished")));
  harness.fire("session_shutdown");
});

test("notifications: matching wait cancels queued ready delivery", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  harness.fire("session_start");
  await harness.call("pwsh", {
    command: "Write-Output READY_FOR_WAIT; Start-Sleep -Seconds 30",
    run_in_background: true,
    notify_on: "READY_FOR_WAIT",
  });
  const result = await harness.call("pwsh_job", { action: "wait", id: "bg-1", pattern: "READY_FOR_WAIT" });
  assert.match(textOf(result), /pattern matched/);
  await sleep(500);
  assert.ok(!harness.messages.some(({ msg }) => msg.content?.includes("background-job-ready")));
  await harness.call("pwsh_job", { action: "kill", id: "bg-1" });
  harness.fire("session_shutdown");
});

test("notifications: killed jobs deliver no queued ready or finished event", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  harness.fire("session_start");
  await harness.call("pwsh", {
    command: "Write-Output READY_TO_KILL; Start-Sleep -Seconds 30",
    run_in_background: true,
    notify_on: "READY_TO_KILL",
  });
  await sleep(750);
  await harness.call("pwsh_job", { action: "kill", id: "bg-1" });
  await sleep(500);
  assert.ok(!harness.messages.some(({ msg }) => msg.content?.includes("background-job-finished")));
  harness.fire("session_shutdown");
});

test("notifications: simultaneous jobs use bounded steering batches", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  harness.fire("session_start");
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      harness.call("pwsh", { command: `Write-Output job-${index}`, run_in_background: true }),
    ),
  );
  await sleep(3_000);
  const delivered = harness.messages.filter(({ msg }) => msg.customType === "pwsh-bg-notify");
  const ids = delivered.flatMap(({ msg }) => msg.details.jobs.map((job: any) => job.id));
  assert.equal(new Set(ids).size, 12);
  assert.equal(ids.length, 12);
  assert.ok(delivered.every(({ msg }) => msg.details.jobs.length <= 10));
  assert.ok(delivered.every(({ msg }) => msg.content.length <= 16_000));
  assert.ok(delivered.every(({ opts }) => opts.deliverAs === "steer" && opts.triggerTurn === true));
  harness.fire("session_shutdown");
});

test("notifications: shutdown disposes a pending retry", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness({ sendFailures: 10 });
  harness.fire("session_start");
  await harness.call("pwsh", { command: "Write-Output retry", run_in_background: true });
  for (let attempt = 0; attempt < 50 && harness.sendAttempts === 0; attempt++) await sleep(50);
  assert.equal(harness.sendAttempts, 1);
  harness.fire("session_shutdown");
  const attemptsAtShutdown = harness.sendAttempts;
  await sleep(1_500);
  assert.equal(harness.sendAttempts, attemptsAtShutdown);
  assert.equal(harness.messages.length, 0);
});

test("lifecycle: explicit kill succeeds and injected trust-boundary failure is surfaced", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  harness.fire("session_start");
  await harness.call("pwsh", { command: "Start-Sleep -Seconds 30", run_in_background: true });
  const previousRoot = process.env.SystemRoot;
  process.env.SystemRoot = String.raw`Z:\definitely-missing-windows`;
  try {
    await assert.rejects(
      harness.call("pwsh_job", { action: "kill", id: "bg-1" }),
      /taskkill\.exe was not found|trusted system path/,
    );
  } finally {
    if (previousRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previousRoot;
  }
  const killed = await harness.call("pwsh_job", { action: "kill", id: "bg-1" });
  assert.match(textOf(killed), /termination requested/);
  assert.equal(killed.structuredContent.stop_outcome, "termination_requested");
  await harness.emit("session_shutdown");
});

test("lifecycle: shutdown settles within its bound and suppresses late notifications", { skip: process.platform !== "win32" }, async () => {
  const before = process.listenerCount("exit");
  const harness = makeHarness();
  harness.fire("session_start");
  await harness.call("pwsh", { command: "Start-Sleep -Seconds 30", run_in_background: true });
  assert.equal(process.listenerCount("exit"), before + 1);
  const started = Date.now();
  await harness.emit("session_shutdown");
  assert.ok(Date.now() - started < 2_500);
  assert.equal(process.listenerCount("exit"), before);
  await sleep(500);
  assert.equal(harness.messages.length, 0);
});

test("lifecycle: fresh extension works after prior instance shutdown", { skip: process.platform !== "win32" }, async () => {
  const first = makeHarness();
  first.fire("session_start");
  await first.call("pwsh", { command: "Start-Sleep -Seconds 30", run_in_background: true });
  await first.emit("session_shutdown");
  const second = makeHarness();
  second.fire("session_start");
  const result = await second.call("pwsh", { command: "Write-Output reload-ok" });
  assert.match(textOf(result), /reload-ok/);
  await second.emit("session_shutdown");
});

test("privacy: foreground and background output create no default complete logs", { skip: process.platform !== "win32" }, async () => {
  const logDirectories = async () => (await readdir(tmpdir())).filter((entry) => entry.startsWith("pi-pwsh-notify-")).sort();
  const before = await logDirectories();
  const harness = makeHarness();
  harness.fire("session_start");
  const foreground = await harness.call("pwsh", {
    command: "Write-Output ('SECRET_FOREGROUND_TOKEN_' + ('s' * 80000))",
  });
  assert.doesNotMatch(textOf(foreground), /Full output|Full log|\.log\b/i);
  const started = await harness.call("pwsh", {
    command: "Write-Output ('SECRET_BACKGROUND_TOKEN_' + ('b' * 450000))",
    run_in_background: true,
  });
  assert.doesNotMatch(textOf(started), /Full output|Full log|\.log\b/i);
  const waited = await harness.call("pwsh_job", { action: "wait", id: "bg-1" });
  assert.doesNotMatch(textOf(waited), /Full output|Full log|\.log\b/i);
  await harness.emit("session_shutdown");
  const after = await logDirectories();
  assert.deepEqual(after, before);
});

test("bounded results: foreground and lines zero stay within Pi limits without log paths", { skip: process.platform !== "win32" }, async () => {
  const foregroundHarness = makeHarness();
  foregroundHarness.fire("session_start");
  const foreground = await foregroundHarness.call("pwsh", {
    command: `1..3000 | ForEach-Object { Write-Output ("foreground-{0:D4}-" -f $_ + ('x' * 40)) }`,
  });
  const foregroundText = textOf(foreground);
  assert.ok(Buffer.byteLength(foregroundText, "utf8") <= DEFAULT_MAX_BYTES);
  assert.ok(foregroundText.split("\n").length <= DEFAULT_MAX_LINES);
  assert.match(foregroundText, /output truncated/);
  assert.doesNotMatch(foregroundText, /Full output|Full log|log path/i);
  foregroundHarness.fire("session_shutdown");

  const backgroundHarness = makeHarness();
  backgroundHarness.fire("session_start");
  await backgroundHarness.call("pwsh", {
    command: `1..3000 | ForEach-Object { Write-Output ("background-{0:D4}-" -f $_ + ('y' * 40)) }`,
    run_in_background: true,
  });
  await backgroundHarness.call("pwsh_job", { action: "wait", id: "bg-1" });
  const background = await backgroundHarness.call("pwsh_job", { action: "output", id: "bg-1", lines: 0 });
  const backgroundText = textOf(background);
  assert.ok(Buffer.byteLength(backgroundText, "utf8") <= DEFAULT_MAX_BYTES);
  assert.ok(backgroundText.split("\n").length <= DEFAULT_MAX_LINES);
  assert.match(backgroundText, /output truncated/);
  assert.doesNotMatch(backgroundText, /Full output|Full log|log path/i);
  backgroundHarness.fire("session_shutdown");
});

test("background buffers: rollover reports missed unseen output", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  harness.fire("session_start");
  await harness.call("pwsh", {
    command: `1..50000 | ForEach-Object { Write-Output ("line-{0:D5}-abcdefghij" -f $_) }`,
    run_in_background: true,
  });
  const result = await harness.call("pwsh_job", { action: "wait", id: "bg-1" });
  assert.match(textOf(result), /rolled out of the in-memory buffer/);
  assert.match(textOf(result), /line-50000/);
  harness.fire("session_shutdown");
});

test("background streams: split UTF-8 and CRLF normalize before settlement", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  harness.fire("session_start");
  const command = [
    `$bytes = [Text.Encoding]::UTF8.GetBytes('🌍')`,
    `$stream = [Console]::OpenStandardOutput()`,
    `foreach ($byte in $bytes) { $stream.WriteByte($byte); $stream.Flush(); Start-Sleep -Milliseconds 40 }`,
    '[Console]::Out.Write("`r`nsecond`rthird`r`n")',
  ].join("\n");
  await harness.call("pwsh", { command, run_in_background: true });
  const result = await harness.call("pwsh_job", { action: "wait", id: "bg-1" });
  assert.match(textOf(result), /🌍/);
  assert.match(textOf(result), /second\nthird/);
  assert.doesNotMatch(textOf(result), /\r/);
  harness.fire("session_shutdown");
});

test("background cursors: concurrent reads do not report output twice", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  harness.fire("session_start");
  await harness.call("pwsh", {
    command: `1..20 | ForEach-Object { Write-Output "cursor-line-$_"; Start-Sleep -Milliseconds 50 }; Start-Sleep -Seconds 2`,
    run_in_background: true,
  });
  await sleep(1_200);
  const [first, second] = await Promise.all([
    harness.call("pwsh_job", { action: "output", id: "bg-1" }),
    harness.call("pwsh_job", { action: "output", id: "bg-1" }),
  ]);
  const lines = (result: any) => textOf(result).split("\n").filter((line: string) => /^cursor-line-\d+$/.test(line.trim()));
  const left = lines(first);
  const right = lines(second);
  assert.equal(left.filter((line: string) => right.includes(line)).length, 0);
  assert.ok(left.length + right.length > 0);
  await harness.call("pwsh_job", { action: "kill", id: "bg-1" });
  harness.fire("session_shutdown");
});

test("execution stress: 32 MiB foreground output stays bounded, coalesces updates, and retains cwd", { skip: process.platform !== "win32" }, async (t) => {
  const harness = makeHarness();
  const updates: Array<{ time: number; text: string }> = [];
  const dir = (process.env.TEMP ?? REPO).replace(/\\$/, "");
  const start = Date.now();
  const rssBefore = process.memoryUsage().rss;
  const result = await harness.call("pwsh", {
    command: `$s = 'x' * 8192; for ($i=0; $i -lt 4096; $i++) { [Console]::Out.WriteLine($s) }; Set-Location '${dir.replaceAll("'", "''")}'; Write-Output FINAL_STRESS_TAIL`,
    timeout: 30,
  }, undefined, (update) => updates.push({ time: Date.now(), text: textOf(update) }));
  const elapsed = Date.now() - start;
  assert.ok(result.details.droppedChars > 30_000_000);
  assert.match(textOf(result), /FINAL_STRESS_TAIL/);
  assert.match(textOf(result), /output truncated/);
  assert.ok(Buffer.byteLength(textOf(result)) <= DEFAULT_MAX_BYTES);
  assert.ok(updates.every((update) => update.text.length <= 4000));
  assert.ok(updates.length <= Math.ceil(elapsed / 100) + 2);
  assert.match(updates.at(-1)!.text, /FINAL_STRESS_TAIL/);
  assert.ok(updates.every((update) => !update.text.includes("pwsh-cwd:")));
  const next = await harness.call("pwsh", { command: "$PWD.Path" });
  assert.match(textOf(next), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  const count = updates.length;
  await sleep(150);
  assert.equal(updates.length, count);
  t.diagnostic(JSON.stringify({ bytesProduced: 4096 * 8193, elapsedMs: elapsed, updates: count,
    droppedChars: result.details.droppedChars, rssDeltaBytes: process.memoryUsage().rss - rssBefore }));
  await harness.emit("session_shutdown");
});

test("user shell streams before completion, strips cwd records, and shares the foreground queue", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  harness.fire("session_start");
  const [{ operations }] = await harness.emit("user_bash") as any;
  let finished = false;
  let early = false;
  let earlyAt = 0;
  let text = "";
  const pending = operations.exec("Write-Output EARLY; Start-Sleep -Milliseconds 500; Write-Output FINAL", REPO, {
    onData(chunk: Buffer) {
      text += chunk.toString();
      if (text.includes("EARLY") && !text.includes("FINAL") && !finished && !early) {
        early = true;
        earlyAt = Date.now();
      }
    },
    timeout: 5,
  }).then((result: any) => { finished = true; return result; });
  assert.equal((await pending).exitCode, 0);
  assert.equal(early, true);
  assert.ok(Date.now() - earlyAt >= 300, "EARLY must stream while the command is still sleeping");
  assert.match(text, /EARLY[\s\S]*FINAL/);
  assert.doesNotMatch(text, /pwsh-cwd:/);
  const dir = (process.env.TEMP ?? REPO).replace(/\\$/, "");
  const user = operations.exec(`Set-Location '${dir.replaceAll("'", "''")}'; Start-Sleep -Milliseconds 200`, REPO, { onData() {} });
  const tool = harness.call("pwsh", { command: "$PWD.Path" });
  await user;
  assert.match(textOf(await tool), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  await harness.emit("session_shutdown");
});

function inheritedPipeCommand(quiet: boolean): string {
  const childCode = quiet
    ? "setTimeout(() => process.exit(0), 2500)"
    : "let n=0; const t=setInterval(() => { console.log('LATE_'+n); if (++n===10) {clearInterval(t); console.log('DESCENDANT_FINAL');} }, 80)";
  const parentCode = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','inherit','inherit'],detached:true}); c.unref(); console.log('PARENT_DONE');`;
  return `& '${process.execPath.replaceAll("'", "''")}' -e '${parentCode.replaceAll("'", "''")}'`;
}

test("inherited pipes: foreground and background retain actively arriving post-exit output", { skip: process.platform !== "win32" }, async () => {
  for (const run_in_background of [false, true]) {
    const harness = makeHarness();
    try {
      let result = await harness.call("pwsh", { command: inheritedPipeCommand(false), run_in_background });
      if (run_in_background) result = await harness.call("pwsh_job", { action: "wait", id: "bg-1", timeout: 5 });
      assert.match(textOf(result), /PARENT_DONE/);
      assert.match(textOf(result), /LATE_9/);
      assert.match(textOf(result), /DESCENDANT_FINAL/);
      if (!run_in_background) assert.equal(result.details.outputIncomplete, false);
      await sleep(350);
      assert.equal(harness.messages.length, 0, "wait observes terminal state without duplicate notification");
    } finally { await harness.emit("session_shutdown"); }
  }
});

test("inherited pipes: quiet descendant cannot hold foreground, background wait or user shell open", { skip: process.platform !== "win32" }, async (t) => {
  for (const mode of ["foreground", "background", "user"]) {
    const harness = makeHarness();
    harness.fire("session_start");
    const start = Date.now();
    try {
      let text: string;
      if (mode === "user") {
        const [{ operations }] = await harness.emit("user_bash") as any;
        text = "";
        await operations.exec(inheritedPipeCommand(true), REPO, { onData(chunk: Buffer) { text += chunk.toString(); } });
      } else {
        let result = await harness.call("pwsh", { command: inheritedPipeCommand(true), run_in_background: mode === "background" });
        if (mode === "background") result = await harness.call("pwsh_job", { action: "wait", id: "bg-1", timeout: 5 });
        text = textOf(result);
      }
      const elapsed = Date.now() - start;
      assert.match(text, /PARENT_DONE/);
      assert.match(text, /output capture ended/);
      assert.ok(elapsed < 2400, `${mode} took ${elapsed}ms (descendant holds pipes for 2500ms after startup)`);
      t.diagnostic(`${mode}: settled in ${elapsed}ms`);
    } finally { await harness.emit("session_shutdown"); }
  }
});

test("user-shell stress: 16 MiB streams to the caller without buffering the complete transcript", { skip: process.platform !== "win32" }, async (t) => {
  const harness = makeHarness();
  const [{ operations }] = await harness.emit("user_bash") as any;
  let bytes = 0;
  let chunks = 0;
  let tail = "";
  let leakedMarker = false;
  const start = Date.now();
  try {
    const result = await operations.exec("$s = 'u' * 8192; for ($i=0; $i -lt 2048; $i++) { [Console]::Out.WriteLine($s) }; Write-Output USER_STRESS_FINAL", REPO, {
      timeout: 30,
      onData(chunk: Buffer) {
        bytes += chunk.length;
        chunks++;
        const text = chunk.toString();
        leakedMarker ||= text.includes("pwsh-cwd:");
        tail = (tail + text).slice(-100);
      },
    });
    assert.equal(result.exitCode, 0);
    assert.ok(bytes > 16_000_000);
    assert.ok(chunks > 10);
    assert.match(tail, /USER_STRESS_FINAL/);
    assert.equal(leakedMarker, false);
    t.diagnostic(JSON.stringify({ userShellBytes: bytes, chunks, elapsedMs: Date.now() - start }));
  } finally { await harness.emit("session_shutdown"); }
});

test("protocol cancellation before a queued launch carries structured abort details", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  const first = harness.call("pwsh", { command: "Start-Sleep -Milliseconds 400; Write-Output FIRST" });
  const controller = new AbortController();
  const second = harness.protocol("pwsh", { command: "Write-Output SHOULD_NOT_RUN" }, controller.signal);
  controller.abort();
  await first;
  const result = await second;
  assert.equal(result.isError, true);
  assert.equal(result.details.aborted, true);
  assert.match(textOf(result), /aborted before launch/);
  assert.doesNotMatch(textOf(result), /SHOULD_NOT_RUN/);
  const success = await harness.protocol("pwsh", { command: "Write-Output RECOVERY" });
  assert.equal(success.isError, false);
  assert.equal(success.details.aborted, false);
  await harness.emit("session_shutdown");
});

test("timeout validation applies to foreground, background, wait and user operations", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  const [{ operations }] = await harness.emit("user_bash") as any;
  for (const timeout of [-1, NaN, Infinity, 2147483.648]) {
    for (const run_in_background of [false, true]) {
      await assert.rejects(harness.call("pwsh", { command: "Write-Output SHOULD_NOT_RUN", timeout, run_in_background }), /Invalid timeout/);
    }
    await assert.rejects(harness.call("pwsh_job", { action: "wait", id: "missing", timeout }), /Invalid timeout/);
    assert.throws(() => operations.exec("", REPO, { timeout, onData() {} }), /Invalid timeout/);
  }
  const result = await harness.call("pwsh", { command: "Write-Output unlimited", timeout: 0 });
  assert.match(textOf(result), /unlimited/);
  assert.match(textOf(await harness.call("pwsh_job", { action: "list" })), /No background jobs/);
  await harness.emit("session_shutdown");
});

test("protocol failure retains output and structured cleanup failure, then retries cleanup at shutdown", { skip: process.platform !== "win32" }, async () => {
  const harness = makeHarness();
  harness.fire("session_start");
  const previous = process.env.SystemRoot;
  try {
    const pending = harness.protocol("pwsh", { command: "Write-Output RETAINED_DIAGNOSTIC; Start-Sleep -Seconds 30", timeout: 2 });
    process.env.SystemRoot = String.raw`Z:\missing-windows-for-cleanup-test`;
    const result = await pending;
    assert.equal(result.isError, true);
    assert.equal(result.details.timedOut, true);
    assert.match(result.details.cleanupError, /taskkill/);
    assert.match(textOf(result), /RETAINED_DIAGNOSTIC/);
    assert.match(textOf(result), /cleanup error/);
  } finally {
    if (previous === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previous;
    await harness.emit("session_shutdown");
  }
});
