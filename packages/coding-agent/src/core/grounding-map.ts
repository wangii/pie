import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import nodePath from "path";

/**
 * Deterministic, bounded codebase grounding for Pie's initial Frame decision.
 *
 * The epistemic control role has no tool access, so the model would otherwise
 * form a Frame's statement/expectation from memory alone. This inventory gives it
 * a compact factual basis — the largest source files in the project — so it can
 * assert a grounded relation and scope its first discovery Action instead of
 * writing an ungrounded "search returns zero matches" expectation.
 */

/** Directory names excluded from traversal. */
const EXCLUDED_DIR_NAMES = new Set([
	"node_modules",
	".git",
	".svn",
	".hg",
	"dist",
	"build",
	"out",
	"coverage",
	".next",
	".nuxt",
	".turbo",
	"target",
	"vendor",
	".venv",
	"venv",
	"__pycache__",
	".cache",
	".idea",
	".vscode",
	".claude",
	".pi",
]);

/** Source / configuration / documentation extensions surfaced in the inventory. */
const SOURCE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".rs",
	".go",
	".java",
	".kt",
	".c",
	".cc",
	".cpp",
	".h",
	".hpp",
	".cs",
	".rb",
	".php",
	".swift",
	".scala",
	".ex",
	".exs",
	".sh",
	".bash",
	".zsh",
	".fish",
	".json",
	".jsonc",
	".yaml",
	".yml",
	".toml",
	".ini",
	".xml",
	".md",
	".mdx",
	".rst",
	".txt",
	".css",
	".scss",
	".less",
	".html",
	".vue",
	".svelte",
	".astro",
	".sql",
	".graphql",
	".proto",
	".prisma",
]);

export interface GroundingMapOptions {
	/** Maximum number of files surfaced, largest first. */
	maxEntries?: number;
	/** Maximum traversal depth below the root. */
	maxDepth?: number;
	/** Hard safety cap on collected entries before sorting. */
	collectionCap?: number;
}

interface GroundingFileEntry {
	path: string;
	bytes: number;
}

async function collectFiles(
	dir: string,
	relativePrefix: string,
	depth: number,
	options: Required<GroundingMapOptions>,
	entries: GroundingFileEntry[],
): Promise<void> {
	if (depth > options.maxDepth || entries.length >= options.collectionCap) return;
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (entries.length >= options.collectionCap) return;
		const absolute = nodePath.join(dir, name);
		const relative = relativePrefix ? `${relativePrefix}/${name}` : name;
		let fileStat: Stats;
		try {
			fileStat = await stat(absolute);
		} catch {
			continue;
		}
		if (fileStat.isDirectory()) {
			if (EXCLUDED_DIR_NAMES.has(name)) continue;
			await collectFiles(absolute, relative, depth + 1, options, entries);
		} else if (fileStat.isFile()) {
			const extension = nodePath.extname(name).toLowerCase();
			if (SOURCE_EXTENSIONS.has(extension)) {
				entries.push({ path: relative, bytes: fileStat.size });
			}
		}
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Build a compact, deterministic inventory of the project's source files,
 * sorted largest-first. Returns an empty string when no source files are found
 * (for example an empty working directory), so callers can skip injection.
 */
export async function buildGroundingMap(cwd: string, options: GroundingMapOptions = {}): Promise<string> {
	const maxEntries = options.maxEntries ?? 200;
	const maxDepth = options.maxDepth ?? 10;
	const collectionCap = options.collectionCap ?? 5000;
	const entries: GroundingFileEntry[] = [];
	await collectFiles(cwd, "", 0, { maxEntries, maxDepth, collectionCap }, entries);
	entries.sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path));
	const surfaced = entries.slice(0, maxEntries);
	if (surfaced.length === 0) return "";
	const lines = surfaced.map((entry) => `${entry.path} (${formatBytes(entry.bytes)})`);
	if (entries.length > surfaced.length) {
		lines.push(`... ${entries.length - surfaced.length} more source files omitted`);
	}
	return lines.join("\n");
}
