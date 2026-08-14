import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGroundingMap } from "../src/core/grounding-map.ts";

describe("buildGroundingMap", () => {
	it("lists source files largest-first and excludes noise directories", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-grounding-"));
		try {
			mkdirSync(join(root, "src", "core"), { recursive: true });
			writeFileSync(join(root, "src", "core", "big.ts"), "a".repeat(2048));
			writeFileSync(join(root, "src", "small.ts"), "b".repeat(8));
			writeFileSync(join(root, "README.md"), "readme");
			mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
			writeFileSync(join(root, "node_modules", "pkg", "dep.js"), "d".repeat(9999));
			mkdirSync(join(root, ".git"), { recursive: true });
			writeFileSync(join(root, ".git", "config"), "git");

			const map = await buildGroundingMap(root);

			expect(map).toContain("src/core/big.ts");
			expect(map).toContain("src/small.ts");
			expect(map).toContain("README.md");
			expect(map).not.toContain("node_modules");
			expect(map).not.toContain(".git");
			expect(map.indexOf("big.ts")).toBeLessThan(map.indexOf("small.ts"));
			expect(map.indexOf("small.ts")).toBeLessThan(map.indexOf("README.md"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns an empty string for an empty directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-grounding-empty-"));
		try {
			expect(await buildGroundingMap(root)).toBe("");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("caps the surfaced entries and reports omissions", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-grounding-cap-"));
		try {
			for (let index = 0; index < 6; index++) {
				writeFileSync(join(root, `file-${index}.ts`), `${index}`.repeat(index + 1));
			}
			const map = await buildGroundingMap(root, { maxEntries: 3 });
			const lines = map.split("\n");
			expect(lines.length).toBeGreaterThan(3);
			expect(map).toContain("more source files omitted");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
