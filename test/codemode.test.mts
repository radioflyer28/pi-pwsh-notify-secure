import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import * as piHost from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

// This suite exercises the actual 0.99 AgentSession pipeline and QuickJS worker, not a nested-call mock.
// On legacy matrix hosts these APIs do not exist; the ordinary integration suite still runs in full.
const host: any = piHost;
const supported = typeof host.createCodemodeExtension === "function";
const require = createRequire(import.meta.url);
const hostRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
async function hostImport(name: string, subpath = ".") {
	const base = hostRequire.resolve.paths(name)?.find(p => existsSync(join(p, name, "package.json")));
	assert.ok(base, `Host dependency not found: ${name}`);
	const manifest = JSON.parse(await readFile(join(base, name, "package.json"), "utf8"));
	const entry = manifest.exports[subpath];
	return import(pathToFileURL(join(base, name, typeof entry === "string" ? entry : entry.import)).href);
}
const jiti = require("jiti")(import.meta.url, { interopDefault: true });
const extension = jiti(fileURLToPath(new URL("../src/index.ts", import.meta.url))).default;
const {pwshOutputSchema, jobOutputSchema} = jiti(fileURLToPath(new URL("../src/results.ts", import.meta.url)));
const enabled = supported && process.platform === "win32";
const textOf = (result: any) => result.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");

async function setup(extra: ((pi: any) => void)[] = [], before: ((pi: any) => void)[] = []) {
	const dir = await mkdtemp(join(tmpdir(), "pwsh-codemode-test-"));
	const ai: any = await hostImport("@earendil-works/pi-ai", "./compat");
	const core: any = await hostImport("@earendil-works/pi-agent-core");
	const faux = ai.registerFauxProvider();
	const model = faux.getModel();
	const settings = host.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const runtime = await host.ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	runtime.registerProvider(model.provider, { baseUrl: model.baseUrl, apiKey: "faux-key", api: faux.api, models: faux.models });
	const schemaErrors: string[] = [];
	const loader = new host.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [host.createCodemodeExtension(), ...before, extension, (pi: any) => {
			pi.on("tool_result", (e: any) => {
				if (e.structuredContent && ["pwsh", "pwsh_job"].includes(e.toolName)) {
					if (!Check(e.toolName === "pwsh" ? pwshOutputSchema : jobOutputSchema, e.structuredContent)) schemaErrors.push(JSON.stringify(e.structuredContent));
				}
			});
		}, ...extra],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const manager = host.SessionManager.inMemory(dir);
	const agent = new core.Agent({ getApiKey: () => "faux-key", streamFn: ai.streamSimple,
		initialState: { model, systemPrompt: "Test", tools: [] }, convertToLlm: host.convertToLlm });
	const session = new host.AgentSession({ agent, sessionManager: manager, settingsManager: settings,
		cwd: dir, modelRuntime: runtime, resourceLoader: loader, initialActiveToolNames: ["pwsh", "pwsh_job", "codemode"] });
	const events: any[] = [];
	session.subscribe((event: any) => events.push(event));
	await session.bindExtensions({});
	return {
		dir, session, events, manager,
		async run(code: string) {
			faux.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("codemode", { code })], { stopReason: "toolUse" }), ai.fauxAssistantMessage("done")]);
			await session.prompt("execute test");
			const result = session.messages.findLast((m: any) => m.role === "toolResult" && m.toolName === "codemode");
			assert.ok(result, JSON.stringify(session.messages));
			return result;
		},
		async close() {
			await session.abort();
			await session.extensionRunner?.emit({ type: "session_shutdown" });
			session.dispose(); faux.unregister();
			await rm(dir, { recursive: true, force: true });
			assert.deepEqual(schemaErrors, [], "actual tool results must satisfy their declared schemas");
		},
	};
}

function value(result: any) {
	assert.equal(result.isError, false, textOf(result));
	return JSON.parse(result.content.slice(1).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n"));
}

test("codemode: structured success, nonzero error data, and rejected invalid calls", { skip: !enabled }, async () => {
	const h = await setup();
	try {
		const r = value(await h.run(`
		const ok = await tools.pwsh({command: "Write-Output success"});
		const failed = await tools.pwsh({command: "Write-Output failure; exit 7"});
		let invalid = false; try { await tools.pwsh({command: "echo no", timeout: -1}); } catch { invalid = true; }
		return {ok, failed, invalid};`));
		assert.equal(r.ok.kind, "foreground"); assert.equal(r.ok.execution.exit_code, 0);
		assert.equal(r.failed.execution.exit_code, 7); assert.match(r.failed.output, /failure/);
		assert.equal(r.invalid, true);
		const nested = h.events.filter(e => e.type === "tool_execution_end" && e.parentToolCallId);
		assert.ok(nested.some(e => e.toolName === "pwsh" && e.isError));
		assert.ok(nested.every(e => e.toolCallId.startsWith(e.parentToolCallId + "/")));
		assert.ok(h.session.messages.filter((m: any) => m.role === "toolResult").every((m: any) => m.toolName === "codemode"));
	} finally { await h.close(); }
});

test("codemode: blocked commands cannot launch and both result representations are redacted", { skip: !enabled }, async () => {
	const h = await setup([(pi: any) => {
		pi.on("tool_call", (event: any) => event.toolName === "pwsh" && event.input.command.includes("FORBIDDEN")
			? { block: true, reason: "permission denied" } : undefined);
		pi.on("tool_result", (event: any) => {
			if (event.toolName !== "pwsh" || !event.input.command.includes("SECRET")) return;
			return { content: [{ type: "text", text: "redacted" }], details: undefined,
				structuredContent: { ...event.structuredContent, output: "redacted" } };
		});
	}]);
	try {
		const r = value(await h.run(`
		let blocked = false;
		try { await tools.pwsh({command: "Set-Content FORBIDDEN.txt bad"}); } catch (e) { blocked = e.message.includes("permission denied"); }
		const r = await tools.pwsh({command: "Write-Output SECRET; exit 3"});
		return {blocked, r};`));
		assert.equal(r.blocked, true); assert.equal(existsSync(join(h.dir, "FORBIDDEN.txt")), false);
		assert.equal(r.r.output, "redacted"); assert.equal(r.r.execution.exit_code, 3);
		assert.doesNotMatch(JSON.stringify(h.session.messages.filter((m: any) => m.role === "toolResult").map((m: any) => m.content)), /SECRET/);
		assert.ok(h.events.some(e => e.type === "tool_execution_end" && e.result?.structuredContent?.output === "redacted"));
	} finally { await h.close(); }
});

test("codemode: consumed output is not printed, concurrent cursors do not duplicate, and replay is explicit", { skip: !enabled }, async () => {
	const h = await setup();
	try {
		const launched = value(await h.run(`return await tools.pwsh({command: "Write-Output PRIVATE_TOKEN; Start-Sleep -Milliseconds 400", run_in_background: true});`));
		const id = launched.job.job_id;
		value(await h.run(`const r = await tools.pwsh_job({action:"wait", id:${JSON.stringify(id)}}); return {kind:r.kind, outcome:r.wait_outcome};`));
		const second = value(await h.run(`return await tools.pwsh_job({action:"output", id:${JSON.stringify(id)}});`));
		assert.equal(second.output, ""); assert.equal(second.cursor_from_utf16, second.cursor_to_utf16);
		assert.doesNotMatch(JSON.stringify(h.session.messages.filter((m: any) => m.role === "toolResult" || m.role === "custom").map((m: any) => m.content)), /PRIVATE_TOKEN/);
		const replay = value(await h.run(`return await tools.pwsh_job({action:"output",id:${JSON.stringify(id)},lines:0});`));
		assert.match(replay.output, /PRIVATE_TOKEN/); assert.equal(replay.replay, true);
		const result = value(await h.run(`
		const b = await tools.pwsh({command:"Write-Output UNIQUE_OUTPUT", run_in_background:true});
		await tools.pwsh({command:"Start-Sleep -Milliseconds 900"});
		return await Promise.all([tools.pwsh_job({action:"output",id:b.job.job_id}),tools.pwsh_job({action:"output",id:b.job.job_id})]);`));
		assert.equal(result.filter((r: any) => r.output.includes("UNIQUE_OUTPUT")).length, 1);
		const notices = h.session.messages.filter((m: any) => m.role === "custom");
		assert.doesNotMatch(JSON.stringify(notices), /PRIVATE_TOKEN|UNIQUE_OUTPUT|Write-Output/);
	} finally { await h.close(); }
});

test("codemode: cwd serialization and wait timeout are independent of process lifetime", { skip: !enabled }, async () => {
	const h = await setup();
	try {
		const r = value(await h.run(`
		const [a,b] = await Promise.all([
		 tools.pwsh({command:"New-Item -ItemType Directory child | Out-Null; Set-Location child"}),
		 tools.pwsh({command:"$PWD.Path"})]);
		const launch = await tools.pwsh({command:"Start-Sleep -Seconds 30", run_in_background:true});
		const wait = await tools.pwsh_job({action:"wait", id:launch.job.job_id, timeout:0.01});
		const stop = await tools.pwsh_job({action:"kill", id:launch.job.job_id});
		return {b,wait,stop};`));
		assert.match(r.b.output, /child/);
		assert.equal(r.wait.wait_outcome, "timeout"); assert.equal(r.wait.job.running, true);
		assert.equal(r.wait.job.execution, null);
		assert.equal(r.stop.stop_outcome, "termination_requested");
	} finally { await h.close(); }
});

test("codemode: launched background job outlives a failed script and stays inspectable", { skip: !enabled }, async () => {
	const h = await setup();
	try {
		const failed = await h.run(`await tools.pwsh({command:"Start-Sleep -Milliseconds 800; Write-Output SURVIVED",run_in_background:true}); throw new Error("script failed");`);
		assert.equal(failed.isError, true);
		const r = value(await h.run(`const list = await tools.pwsh_job({action:"list"}); return await tools.pwsh_job({action:"wait",id:list.jobs[0].job_id});`));
		assert.equal(r.job.execution.exit_code, 0); assert.match(r.output, /SURVIVED/);
	} finally { await h.close(); }
});

test("codemode: execution timeout and cleanup failure retain structured diagnostics", { skip: !enabled }, async () => {
	const h = await setup();
	const oldRoot = process.env.SystemRoot;
	try {
		const timed = value(await h.run(`return await tools.pwsh({command:"Start-Sleep -Seconds 30",timeout:0.4});`));
		assert.equal(timed.execution.timed_out, true);
		process.env.SystemRoot = join(h.dir, "missing-system-root");
		const failed = value(await h.run(`return await tools.pwsh({command:"Write-Output diagnostic; Start-Sleep -Seconds 30",timeout:0.8});`));
		assert.equal(failed.execution.timed_out, true); assert.ok(failed.execution.cleanup_error);
		assert.match(failed.output, /diagnostic/); assert.equal(failed.execution.output_incomplete, true);
	} finally {
		if (oldRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = oldRoot;
		await h.close();
	}
});

test("codemode: unawaited foreground calls are cancelled and terminated", { skip: !enabled, timeout: 15000 }, async () => {
	let ready!: () => void;
	const outputReady = new Promise<void>(resolve => { ready = resolve; });
	let pid = 0;
	const h = await setup([(pi: any) => {
		pi.registerTool({ name:"test_barrier", label:"barrier", description:"Wait for process output", parameters:{type:"object",properties:{}},
			execute: async () => { await outputReady; return {content:[{type:"text",text:"ready"}],details:undefined}; } });
		pi.on("tool_execution_update", (e: any) => {
			const match = JSON.stringify(e.partialResult).match(/PROCESS_PID=(\d+)/);
			if (match) { pid = Number(match[1]); ready(); }
		});
	}]);
	try {
		h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "test_barrier"]);
		await h.run(`tools.pwsh({command:"Write-Output PROCESS_PID=$PID; Start-Sleep -Seconds 30"}); await tools.test_barrier({}); return "finished";`);
		assert.ok(pid > 0);
		assert.throws(() => process.kill(pid, 0), /ESRCH/);
		// Pi may deliver the cancelled nested end after the parent settles; the OS liveness check is the cleanup proof.
		assert.ok(h.events.some(e => e.type === "tool_execution_start" && e.toolName === "pwsh" && e.parentToolCallId));
	} finally { await h.close(); }
});

test("codemode: active shell pruning and unavailable-runtime gating apply to callable tools", { skip: !enabled }, async () => {
	const h = await setup();
	try {
		h.session.setActiveToolsByName(["bash", "powershell", "pwsh", "pwsh_job", "codemode"]);
		const names = value(await h.run(`return ALL_TOOLS.map(t=>t.name);`));
		assert.ok(names.includes("pwsh")); assert.ok(!names.includes("bash")); assert.ok(!names.includes("powershell"));
	} finally { await h.close(); }
	const old = process.env.PI_PWSH_NOTIFY_EXECUTABLE;
	process.env.PI_PWSH_NOTIFY_EXECUTABLE = ".\\untrusted.exe";
	let unavailable;
	try {
		unavailable = await setup();
		const names = value(await unavailable.run(`return ALL_TOOLS.map(t=>t.name);`));
		assert.ok(!names.includes("pwsh")); assert.ok(!names.includes("pwsh_job"));
	} finally {
		if (old === undefined) delete process.env.PI_PWSH_NOTIFY_EXECUTABLE; else process.env.PI_PWSH_NOTIFY_EXECUTABLE = old;
		await unavailable?.close();
	}
});

test("codemode: cancelling an active script kills foreground execution", { skip: !enabled, timeout: 15000 }, async () => {
	let ready!: () => void;
	const outputReady = new Promise<void>(resolve => { ready = resolve; });
	let pid = 0;
	const h = await setup([(pi: any) => {
		pi.on("tool_execution_update", (e: any) => {
			const match = JSON.stringify(e.partialResult).match(/CANCEL_PID=(\d+)/);
			if (match) { pid = Number(match[1]); ready(); }
		});
	}]);
	try {
		const pending = h.run(`return await tools.pwsh({command:"Write-Output CANCEL_PID=$PID; Start-Sleep -Seconds 30"});`);
		// Attach a rejection handler immediately: abort may end the parent without a codemode result.
		const settled = pending.then(() => undefined, () => undefined);
		await outputReady;
		await h.session.abort();
		await settled;
		assert.ok(pid > 0); assert.throws(() => process.kill(pid,0), /ESRCH/);
	} finally { await h.close(); }
});

test("codemode: content-only redaction drops structured output instead of leaking a second channel", { skip: !enabled }, async () => {
	const h = await setup([(pi: any) => {
		pi.on("tool_result", (e: any) => e.toolName === "pwsh" ? {content:[{type:"text",text:"redacted"}], details:undefined} : undefined);
	}]);
	try {
		assert.equal(value(await h.run(`return {redacted:await tools.pwsh({command:"Write-Output PRIVATE"})};`)).redacted, "redacted");
	} finally { await h.close(); }
	// The legacy error bridge must not restore data a previously registered hook already redacted.
	const early = await setup([], [(pi: any) => {
		pi.on("tool_result", (e: any) => e.toolName === "pwsh" ? {content:[{type:"text",text:"early redaction"}],details:undefined} : undefined);
	}]);
	try {
		assert.equal(value(await early.run(`try { await tools.pwsh({command:"Write-Output PRIVATE; exit 2"}); } catch(e) { return {error:e.message}; }`)).error, "early redaction");
	} finally { await early.close(); }
});
