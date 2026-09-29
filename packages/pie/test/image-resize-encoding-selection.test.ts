/**
 * Regression tests for the encoding chosen by `resizeImageInProcess`.
 *
 * A 4K screenshot resized to 2000x1125 encodes to ~2.9MB of base64 as PNG but
 * only ~0.35MB as JPEG q80. The resize profile therefore has to compare the two
 * encodings and keep the smaller one: picking PNG unconditionally is what pushed
 * real sessions past a provider's request body limit (HTTP 413
 * "Failed to buffer the request body: length limit exceeded").
 */

import { describe, expect, it } from "vitest";
import { resizeImage } from "../src/utils/image-resize.ts";
import { loadPhoton } from "../src/utils/photon.ts";

/** deepseek-flash `inputLimits.images.resize` from packages/ai/src/providers/data/deepseek.json. */
const SCREENSHOT_RESIZE_PROFILE = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: 4718592,
	jpegQuality: 80,
};

/** Encode raw pixels to PNG bytes with photon. */
async function encodePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]) {
	const photon = await loadPhoton();
	if (!photon) {
		throw new Error("photon unavailable");
	}
	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b] = pixel(x, y);
			const i = (y * width + x) * 4;
			pixels[i] = r;
			pixels[i + 1] = g;
			pixels[i + 2] = b;
			pixels[i + 3] = 255;
		}
	}
	const image = new photon.PhotonImage(pixels, width, height);
	try {
		return image.get_bytes();
	} finally {
		image.free();
	}
}

/**
 * Build a deterministic screenshot-like 4K image: large flat UI panels, a few
 * dark text-like strokes. Reproducible across runs via a seeded LCG.
 */
async function makeScreenshotLikePng(width: number, height: number): Promise<Uint8Array> {
	const photon = await loadPhoton();
	if (!photon) {
		throw new Error("photon unavailable");
	}

	const pixels = new Uint8Array(width * height * 4);
	let seed = 0x2f6e2b1;
	const rand = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	const put = (x: number, y: number, r: number, g: number, b: number) => {
		const i = (y * width + x) * 4;
		pixels[i] = Math.max(0, Math.min(255, r));
		pixels[i + 1] = Math.max(0, Math.min(255, g));
		pixels[i + 2] = Math.max(0, Math.min(255, b));
		pixels[i + 3] = 255;
	};

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const panel = Math.floor(x / 320) % 2 === Math.floor(y / 240) % 2;
			const base = panel ? 236 : 28;
			put(x, y, base, base, base + (panel ? 4 : 10));
		}
	}
	const strokes = Math.floor((width * height) / 400);
	for (let s = 0; s < strokes; s++) {
		const x0 = Math.floor(rand() * (width - 40));
		const y0 = Math.floor(rand() * height);
		const len = 6 + Math.floor(rand() * 30);
		for (let d = 0; d < len; d++) {
			put(x0 + d, y0, 60, 60, 64);
		}
	}

	const image = new photon.PhotonImage(pixels, width, height);
	try {
		return image.get_bytes();
	} finally {
		image.free();
	}
}

describe("resizeImage encoding selection", () => {
	it("prefers JPEG when it is smaller than a lossless PNG that would also fit", async () => {
		const screenshot = await makeScreenshotLikePng(3840, 2160);

		const result = await resizeImage(screenshot, "image/png", SCREENSHOT_RESIZE_PROFILE);

		expect(result).not.toBeNull();
		expect(result!.width).toBe(2000);
		// PNG at 2000x1125 is ~1.1MB of base64; JPEG q80 is ~0.41MB. Both fit the
		// 4.5MB budget, so the smaller one has to win.
		expect(result!.mimeType).toBe("image/jpeg");
		expect(result!.data.length).toBeLessThan(600_000);
		// Guard against dropping below the configured quality: JPEG q70 is ~0.35MB.
		expect(result!.data.length).toBeGreaterThan(360_000);
	});

	it("keeps lossless PNG when PNG is the smaller encoding", async () => {
		// Flat UI content compresses far better as PNG than as JPEG, so the
		// comparison must not blindly prefer JPEG.
		const flat = await encodePng(400, 400, (x, y) =>
			(Math.floor(x / 50) + Math.floor(y / 50)) % 2 === 0 ? [240, 240, 244] : [32, 32, 36],
		);

		const result = await resizeImage(flat, "image/png", {
			...SCREENSHOT_RESIZE_PROFILE,
			maxWidth: 200,
			maxHeight: 200,
		});

		expect(result).not.toBeNull();
		expect(result!.wasResized).toBe(true);
		expect(result!.mimeType).toBe("image/png");
	});
});
