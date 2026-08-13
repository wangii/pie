import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { ActionExecutionTraceComponent } from "../src/modes/interactive/components/action-execution-trace.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function render(component: ActionExecutionTraceComponent): string {
	return stripAnsi(component.render(160).join("\n"));
}

describe("ActionExecutionTraceComponent", () => {
	beforeAll(() => initTheme("dark"));

	it("collapses execution noise into structural counts and preserves exact expandable detail", () => {
		const tool = new ToolExecutionComponent(
			"custom_tool",
			"call-1",
			{ path: "fixture.txt" },
			{},
			undefined,
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
		const trace = new ActionExecutionTraceComponent("action-1");
		trace.addAttempt("call-1", "custom_tool", tool);
		trace.recordStreamedUpdate("call-1", "custom_tool", {
			content: [{ type: "text", text: "first chunk" }],
			details: { sequence: 1 },
		});
		trace.recordStreamedUpdate("call-1", "custom_tool", {
			content: [{ type: "text", text: "first chunk\nsecond chunk" }],
			details: { sequence: 2 },
		});
		tool.updateResult({ content: [{ type: "text", text: "final result" }], isError: true });
		trace.finishAttempt("call-1", true);
		trace.recordRepair({
			setExpanded: () => {},
			render: () => ["repair classification"],
			invalidate: () => {},
		});
		trace.markTerminal("unresolvable");

		const collapsed = render(trace);
		expect(collapsed).toContain(
			"1 attempt (1 finalized, 1 tool error) · 1 repair · 2 streamed updates · unresolvable",
		);
		expect(collapsed).not.toContain("first chunk");
		expect(collapsed).not.toContain("final result");
		expect(collapsed).not.toContain("repair classification");

		trace.setExpanded(true);
		const expanded = render(trace);
		expect(expanded).toContain("action-1");
		expect(expanded).toContain("Attempt 1 started · custom_tool · call call-1");
		expect(expanded).toContain("Stream update 1 · custom_tool · call call-1");
		expect(expanded.indexOf("Attempt 1 started")).toBeLessThan(expanded.indexOf("Stream update 1"));
		expect(expanded.indexOf("Stream update 2")).toBeLessThan(expanded.indexOf("final result"));
		expect(expanded).toContain("first chunk");
		expect(expanded).toContain("second chunk");
		expect(expanded).toContain('details: {"sequence":2}');
		expect(expanded).toContain("final result");
		expect(expanded).toContain("repair classification");
	});

	it("reports a zero-attempt active Action without inventing a narrative summary", () => {
		const trace = new ActionExecutionTraceComponent("action-empty");
		expect(render(trace).trimEnd()).toBe(" Action trace · 0 attempts · 0 repairs · 0 streamed updates · active");
	});
});
