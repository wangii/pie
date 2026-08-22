/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getReadmePath } from "../config.ts";
import { formatSkillCatalogForPrompt, formatSkillsForPrompt, type Skill } from "./skills.ts";

/**
 * The operating role the prompt is assembled for. The default `"coding"` role renders
 * the file/command-agent preamble plus the pi-docs index and file-path guideline. The
 * belief-loop roles render a narrower scientific preamble and omit the pi-docs block:
 * `"propose"`, `"distill"`, and `"finalAnswer"` have no `read`/`bash`/`edit`/`write`
 * (advertising them would only mislead the model), while `"execution"` holds those probe
 * tools but must not be distracted by the pi-docs block, which is unrelated to the belief
 * it is probing.
 */
export type SystemPromptRole = "coding" | "propose" | "planner" | "distill" | "execution" | "finalAnswer";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
	/** Operating role for this prompt. Defaults to `"coding"`. */
	role?: SystemPromptRole;
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		role = "coding",
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && contextFiles.length > 0) {
			prompt += "\n\n<project_context>\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
			}
			prompt += "</project_context>\n";
		}

		// Append skills section (only if read tool is available)
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// The propose role has no `read`, so the full skills block is not rendered above, but it
		// still needs a lightweight catalog so it can reference skills by id via `skillRefs`.
		if (role === "propose" && !customPromptHasRead && skills.length > 0) {
			prompt += formatSkillCatalogForPrompt(skills);
		}

		prompt += `\nCurrent working directory: ${promptCwd}\n`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	if (role === "coding") {
		addGuideline("Show file paths clearly when working with files");
	}

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	const preamble =
		role === "propose" || role === "distill"
			? "You are a scientific mind investigating a task by forming and testing beliefs about the product and code."
			: role === "planner"
				? "You are the batching planner of a belief-loop investigation: you group the open beliefs into the next execution batch."
				: role === "execution"
					? "You are a scientific mind running an experiment: you probe the code or product for evidence about a belief and report what you observe."
					: role === "finalAnswer"
						? "You are a scientific mind concluding an investigation and answering the user's task."
						: "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

	let prompt = `${preamble}

Available tools:
${toolsList}
`;

	if (role === "coding") {
		prompt +=
			"\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n";
	}

	prompt += `
Guidelines:
${guidelines}
`;

	if (role === "coding") {
		prompt += `
Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- When reading pi docs, resolve docs/... under Additional docs, not the current working directory
- When asked about: extensions (docs/extensions.md), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on pi topics, read the docs and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;
	}

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files (only if read tool is available — a role that cannot
	// read files should not be handed project instructions like "read files in full",
	// which would only mislead it; same gate as the skills block below).
	if (hasRead && contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// The propose role has no `read`, so the full skills block is not rendered above, but it
	// still needs a lightweight catalog so it can reference skills by id via `skillRefs`.
	if (role === "propose" && !hasRead && skills.length > 0) {
		prompt += formatSkillCatalogForPrompt(skills);
	}

	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
