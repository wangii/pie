#!/usr/bin/env node
/**
 * Syncs pie's shared (non-forked) source files from coding-agent.
 *
 * For every file under packages/coding-agent/src that is NOT listed in
 * packages/pie/FORKED_FILES, copy it verbatim to the mirror path under
 * packages/pie/src; delete any pie/src file that no longer exists in
 * coding-agent/src (and isn't forked).
 *
 * Also regenerates packages/pie/.gitignore from FORKED_FILES, so the ignore
 * whitelist cannot drift from the manifest.
 *
 * Modes:
 *   node scripts/sync-pie-shared.mjs           # apply changes
 *   node scripts/sync-pie-shared.mjs --list    # print planned changes, no writes
 *   node scripts/sync-pie-shared.mjs --check   # exit 1 if any change would be made
 *
 * This script only READS packages/coding-agent; it never writes there.
 */
import {
	readFileSync,
	writeFileSync,
	mkdirSync,
	readdirSync,
	statSync,
	rmSync,
	existsSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const srcDir = join(repoRoot, "packages", "coding-agent", "src");
const dstDir = join(repoRoot, "packages", "pie", "src");
const manifestPath = join(repoRoot, "packages", "pie", "FORKED_FILES");
const gitignorePath = join(repoRoot, "packages", "pie", ".gitignore");

const mode = process.argv.includes("--check") ? "check" : process.argv.includes("--list") ? "list" : "apply";

function readManifest() {
	if (!existsSync(manifestPath)) {
		throw new Error(`Manifest not found: ${manifestPath}`);
	}
	const forked = new Set();
	for (let line of readFileSync(manifestPath, "utf8").split("\n")) {
		line = line.trim();
		if (!line || line.startsWith("#")) continue;
		forked.add(line.replace(/^\/+/, ""));
	}
	return forked;
}

/** Recursively index files under `dir`, mapping relative path -> absolute path. */
function walk(dir) {
	const files = new Map();
	const recurse = (cur) => {
		for (const name of readdirSync(cur)) {
			const abs = join(cur, name);
			if (statSync(abs).isDirectory()) {
				recurse(abs);
			} else {
				files.set(relative(dir, abs).split("\\").join("/"), abs);
			}
		}
	};
	recurse(dir);
	return files;
}

const forked = readManifest();
const src = walk(srcDir);
const dst = walk(dstDir);

const toCopy = [];
const toDelete = [];

for (const [rel, srcAbs] of src) {
	if (forked.has(rel)) continue;
	const dstAbs = join(dstDir, rel);
	if (!existsSync(dstAbs)) {
		toCopy.push(rel);
	} else if (!readFileSync(dstAbs).equals(readFileSync(srcAbs))) {
		toCopy.push(rel);
	}
}

for (const rel of dst.keys()) {
	if (forked.has(rel)) continue;
	if (!src.has(rel)) toDelete.push(rel);
}

toCopy.sort();
toDelete.sort();

/**
 * pie/.gitignore whitelists exactly the forked files, so it is derived from the manifest
 * rather than hand-maintained: `src/**` ignores every synced file, then each parent directory
 * and file named in FORKED_FILES is re-included. Git cannot re-include a file whose parent
 * directory is excluded, hence the directory negations.
 */
function expectedGitignore() {
	const dirs = new Set();
	for (const rel of forked) {
		const parts = rel.split("/");
		for (let i = 1; i < parts.length; i++) {
			dirs.add(parts.slice(0, i).join("/"));
		}
	}
	const lines = [
		"*.bun-build",
		"",
		"# Generated from FORKED_FILES by scripts/sync-pie-shared.mjs — do not edit by hand.",
		"# Only forked source files are maintained in this package; everything else under src/",
		"# is synced verbatim from packages/coding-agent/src.",
		"src/**",
	];
	for (const dir of [...dirs].sort()) lines.push(`!src/${dir}/`);
	for (const rel of [...forked].sort()) lines.push(`!src/${rel}`);
	return `${lines.join("\n")}\n`;
}

const nextGitignore = expectedGitignore();
const currentGitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
const gitignoreStale = currentGitignore !== nextGitignore;

function report() {
	const changed = toCopy.length + toDelete.length;
	if (changed === 0 && !gitignoreStale) {
		console.log("pie/src is in sync with coding-agent/src (outside FORKED_FILES).");
		return 0;
	}
	if (toCopy.length > 0) {
		console.log(`Will copy ${toCopy.length} file(s) from coding-agent/src -> pie/src:`);
		for (const rel of toCopy) console.log(`  + ${rel}`);
	}
	if (toDelete.length > 0) {
		console.log(`Will delete ${toDelete.length} stale file(s) from pie/src:`);
		for (const rel of toDelete) console.log(`  - ${rel}`);
	}
	if (gitignoreStale) {
		console.log("Will regenerate pie/.gitignore from FORKED_FILES.");
	}
	return changed + (gitignoreStale ? 1 : 0);
}

if (mode === "list") {
	report();
} else if (mode === "check") {
	const n = report();
	if (n > 0) {
		console.error("Drift detected. Run `node scripts/sync-pie-shared.mjs` to sync.");
		process.exit(1);
	}
} else {
	for (const rel of toCopy) {
		const dstAbs = join(dstDir, rel);
		mkdirSync(dirname(dstAbs), { recursive: true });
		writeFileSync(dstAbs, readFileSync(join(srcDir, rel)));
	}
	for (const rel of toDelete) {
		rmSync(join(dstDir, rel), { force: true });
	}
	if (gitignoreStale) {
		writeFileSync(gitignorePath, nextGitignore);
	}
	console.log(
		`Synced: ${toCopy.length} copied, ${toDelete.length} deleted, pie/.gitignore ${gitignoreStale ? "regenerated" : "unchanged"}.`,
	);
}
