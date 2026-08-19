import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test("epistemic role omits the coding-agent preamble, pi docs, and file-path guideline", () => {
			const prompt = buildSystemPrompt({
				role: "epistemic",
				selectedTools: ["declare_belief", "view_beliefs"],
				toolSnippets: {
					declare_belief: "Record or update what you currently believe",
					view_beliefs: "View your current beliefs",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("You are a scientific mind investigating a task by forming and testing beliefs");
			expect(prompt).not.toContain("reading files");
			expect(prompt).not.toContain("executing commands");
			expect(prompt).not.toContain("expert coding assistant");
			expect(prompt).not.toContain("In addition to the tools above");
			expect(prompt).not.toContain("Pi documentation");
			expect(prompt).not.toContain("Show file paths clearly");
			// The belief tools are still enumerated.
			expect(prompt).toContain("- declare_belief:");
			expect(prompt).toContain("- view_beliefs:");
		});

		test("execution role uses a probe preamble and omits the pi-docs block and coding identity", () => {
			const prompt = buildSystemPrompt({
				role: "execution",
				selectedTools: ["read", "bash", "view_beliefs"],
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					view_beliefs: "View your current beliefs",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			// A probe identity, not the file/command-agent identity.
			expect(prompt).toContain("You are a scientific mind running an experiment");
			expect(prompt).not.toContain("expert coding assistant");
			// No pi-docs block or coding-only guideline to distract the probe.
			expect(prompt).not.toContain("Pi documentation");
			expect(prompt).not.toContain("In addition to the tools above");
			expect(prompt).not.toContain("Show file paths clearly");
			// …but its probe tools (and the read-only belief view) are still enumerated.
			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- view_beliefs:");
		});

		test("instructs models to resolve pi docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
			expect(prompt).toContain("environment variables (docs/environment-variables.md)");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});
});
