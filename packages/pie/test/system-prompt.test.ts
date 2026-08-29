import { describe, expect, test } from "vitest";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
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

			for (const name of ["read", "bash", "edit", "write"]) {
				expect(prompt).toContain(`- ${name}:`);
			}
		});

		test("propose role gets a lightweight skill catalog without read guidance", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["declare_belief", "view_beliefs", "conclude"],
				role: "propose",
				skills: [
					{
						name: "add-llm-provider",
						description: "Checklist for adding a provider",
						filePath: "/x/add-llm-provider.md",
						baseDir: "/x",
						sourceInfo: createSyntheticSourceInfo("/x/add-llm-provider.md", { source: "project" }),
						disableModelInvocation: false,
					},
				],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("<available_skills>");
			expect(prompt).toContain("<name>add-llm-provider</name>");
			expect(prompt).not.toContain("Use the read tool to load a skill's file");
		});

		test("coding role with read still gets the full skills block", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read"],
				role: "coding",
				skills: [
					{
						name: "add-llm-provider",
						description: "Checklist for adding a provider",
						filePath: "/x/add-llm-provider.md",
						baseDir: "/x",
						sourceInfo: createSyntheticSourceInfo("/x/add-llm-provider.md", { source: "project" }),
						disableModelInvocation: false,
					},
				],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Use the read tool to load a skill's file");
		});

		test("epistemic role omits the coding-agent preamble, pi docs, and file-path guideline", () => {
			const prompt = buildSystemPrompt({
				role: "propose",
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

		test("non-read roles omit project context files", () => {
			const contextFiles = [{ path: "AGENTS.md", content: "read files in full" }];
			const coding = buildSystemPrompt({ contextFiles, skills: [], cwd: process.cwd() });
			const epistemic = buildSystemPrompt({
				role: "propose",
				selectedTools: ["declare_belief", "view_beliefs"],
				toolSnippets: { declare_belief: "Record beliefs", view_beliefs: "View beliefs" },
				contextFiles,
				skills: [],
				cwd: process.cwd(),
			});

			// The coding role has read, so it receives the project instructions…
			expect(coding).toContain("<project_context>");
			expect(coding).toContain("read files in full");
			// …but the epistemic role (no read) does not, matching the skills gate.
			expect(epistemic).not.toContain("<project_context>");
			expect(epistemic).not.toContain("read files in full");
		});

		test("instructs models to resolve pi docs under absolute base paths", () => {
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
