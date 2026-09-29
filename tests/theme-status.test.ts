import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as host from "@earendil-works/pi-coding-agent";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { renderPwshCall, renderPowerShellResult, type PowerShellRenderContext } from "../src/ui/powershell-tool-renderers.ts";

const jiti = createRequire(import.meta.url)("jiti")(import.meta.url, { interopDefault: true });
const { JobViewer } = jiti(fileURLToPath(new URL("../src/ui/job-viewer.ts", import.meta.url)));
const { JobList } = jiti(fileURLToPath(new URL("../src/ui/job-list.ts", import.meta.url)));
const { jobStatusText } = jiti(fileURLToPath(new URL("../src/job-status.ts", import.meta.url)));

host.initTheme();
// Pinned-host integration seam: theme lookup is not a public index export.
const themeModule = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);

test("tool renderer caches rebuild for dark/light/system themes without changing result data", () => {
	const ctx: PowerShellRenderContext<any> = { args:{command:"Write-Output 界😀"}, toolCallId:"theme-test", invalidate(){},
		lastComponent:undefined, state:{}, cwd:"C:/work", executionStarted:false, argsComplete:true, isPartial:false,
		expanded:false, showImages:false, isError:false };
	const result = Object.freeze({ content:[{type:"text" as const,text:"line\n界😀"}], details:undefined });
	const original = JSON.stringify(result);
	const rctx = { ...ctx, lastComponent: undefined as PowerShellRenderContext["lastComponent"] };
	for (const name of ["dark", "light", "system", "dark"]) {
		const theme = themeModule.getThemeByName(name);
		if (!theme) { assert.equal(name, "system"); continue; } // system did not exist on the supported floor
		const call = renderPwshCall(ctx.args, theme, ctx);
		call.invalidate();
		for (const width of [1, 12, 80]) assert.ok(call.render(width).every(line => visibleWidth(line) <= width));
		assert.deepEqual(call.render(80), renderPwshCall(ctx.args, theme, {...ctx,lastComponent:undefined}).render(80));
		ctx.lastComponent = call;
		const component = renderPowerShellResult(result, {expanded:false,isPartial:false}, theme, rctx);
		component.invalidate();
		for (const width of [1, 12, 80]) assert.ok(component.render(width).every(line => visibleWidth(line) <= width));
		assert.deepEqual(component.render(80), renderPowerShellResult(result, {expanded:false,isPartial:false}, theme, {...rctx,lastComponent:undefined}).render(80));
		rctx.lastComponent = component;
		assert.equal(JSON.stringify(result), original);
	}
});

test("viewer and list share conservative failure labels and permit cleanup retry", () => {
	const job = { id:"bg-1", command:"test", cwd:"C:/work", proc:{pid:1234}, output:"x", running:false,
		killedByTool:true, timedOut:true, exitCode:0, startedAt:Date.now()-10000, endedAt:Date.now()-5000,
		outcome:{exitCode:0,signal:null,aborted:false,timedOut:true,outputIncomplete:true,droppedChars:0,cleanupError:"denied"},
		watchers:new Set(), baseOffset:0, cursor:0 };
	const theme = themeModule.getThemeByName("dark");
	const tui = {terminal:{rows:30},requestRender(){}};
	let kills = 0;
	const viewer = new JobViewer(tui,job,theme,()=>{},()=>{kills++;});
	const label = jobStatusText(job);
	assert.match(label,/cleanup failed/);
	assert.ok(viewer.render(180).map(stripTerminalSequences).join("\n").includes(label));
	viewer.handleInput("x"); viewer.handleInput("x"); assert.equal(kills,1);
	let widget: any;
	const list = new JobList(new Map([[job.id,job]]),()=>{});
	list.setUICtx({setWidget(_key: string, value: any){widget=value;},onTerminalInput(){return ()=>{};},getEditorText(){return "";},notify(){},custom:async()=>{}});
	try {
		list.update(); assert.ok(widget,"failed cleanup must not disappear after ordinary finished-job linger");
		const component = widget(tui,theme);
		assert.ok(component.render(180).map(stripTerminalSequences).join("\n").includes(label));
		for (const width of [30,80]) assert.ok(component.render(width).every((line: string)=>visibleWidth(line)<=width));
	} finally { viewer.dispose(); list.dispose(); }
});
