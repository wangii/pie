import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

export interface ImageResizeOptions {
	maxWidth?: number; // Default: 2000
	maxHeight?: number; // Default: 2000
	maxBytes?: number; // Default: 4.5MB of base64 payload (below Anthropic's 5MB limit)
	jpegQuality?: number; // Default: 80
}

export interface ResizedImage {
	data: string; // base64
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
}

// 4.5MB of base64 payload. Provides headroom below Anthropic's 5MB limit.
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: DEFAULT_MAX_BYTES,
	jpegQuality: 80,
};

interface EncodedCandidate {
	data: string;
	encodedSize: number;
	mimeType: string;
}

function encodeCandidate(buffer: Uint8Array, mimeType: string): EncodedCandidate {
	const data = Buffer.from(buffer).toString("base64");
	return {
		data,
		encodedSize: Buffer.byteLength(data, "utf-8"),
		mimeType,
	};
}

/**
 * Resize an image to fit within the specified max dimensions and encoded file size.
 * Returns null if the image cannot be resized below maxBytes.
 *
 * Uses Photon (Rust/WASM) for image processing. If Photon is not available,
 * returns null.
 *
 * Strategy for staying under maxBytes:
 * 1. First resize to maxWidth/maxHeight
 * 2. Encode PNG and JPEG at jpegQuality, keep the smaller of the two
 * 3. If neither fits, try JPEG with decreasing quality
 * 4. If still too large, progressively reduce dimensions until 1x1
 *
 * Step 2 matters for whole-request size: a 2000x1125 screenshot is ~2.9MB of
 * base64 as PNG but ~0.35MB as JPEG q80. Choosing the PNG because it happened to
 * fit the per-image budget is how a couple of images overflow a provider's
 * request body limit.
 */
export async function resizeImageInProcess(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;

	const photon = await loadPhoton();
	if (!photon) {
		return null;
	}

	let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes);
		image = applyExifOrientation(photon, rawImage, inputBytes);
		if (image !== rawImage) rawImage.free();

		const originalWidth = image.get_width();
		const originalHeight = image.get_height();
		const format = mimeType.split("/")[1] ?? "png";

		// Check if already within all limits (dimensions AND encoded size)
		if (originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight && inputBase64Size < opts.maxBytes) {
			return {
				data: Buffer.from(inputBytes).toString("base64"),
				mimeType: mimeType || `image/${format}`,
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
			};
		}

		// Calculate initial dimensions respecting max limits
		let targetWidth = originalWidth;
		let targetHeight = originalHeight;

		if (targetWidth > opts.maxWidth) {
			targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth);
			targetWidth = opts.maxWidth;
		}
		if (targetHeight > opts.maxHeight) {
			targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight);
			targetHeight = opts.maxHeight;
		}

		function buildResult(candidate: EncodedCandidate, width: number, height: number): ResizedImage {
			return {
				data: candidate.data,
				mimeType: candidate.mimeType,
				originalWidth,
				originalHeight,
				width,
				height,
				wasResized: true,
			};
		}

		const qualitySteps = Array.from(new Set([opts.jpegQuality, 85, 70, 55, 40]));
		const lowerQualities = qualitySteps.filter((quality) => quality < opts.jpegQuality);
		let currentWidth = targetWidth;
		let currentHeight = targetHeight;

		while (true) {
			const resized = photon.resize(image, currentWidth, currentHeight, photon.SamplingFilter.Lanczos3);
			try {
				// Encode lossless PNG and JPEG at the configured quality, then keep the
				// smaller of the two. Photographic and heavily antialiased content — a
				// desktop screenshot, say — is several times smaller as JPEG, and
				// keeping the PNG there is what pushes a whole provider request past
				// its body limit once a few images are in the conversation.
				const png = encodeCandidate(resized.get_bytes(), "image/png");
				const configuredJpeg = encodeCandidate(resized.get_bytes_jpeg(opts.jpegQuality), "image/jpeg");
				const best = png.encodedSize <= configuredJpeg.encodedSize ? png : configuredJpeg;
				if (best.encodedSize < opts.maxBytes) {
					return buildResult(best, currentWidth, currentHeight);
				}

				// Neither fits: trade quality for size before giving up bytes by
				// shrinking dimensions.
				for (const quality of lowerQualities) {
					const candidate = encodeCandidate(resized.get_bytes_jpeg(quality), "image/jpeg");
					if (candidate.encodedSize < opts.maxBytes) {
						return buildResult(candidate, currentWidth, currentHeight);
					}
				}
			} finally {
				resized.free();
			}

			if (currentWidth === 1 && currentHeight === 1) {
				break;
			}

			const nextWidth = currentWidth === 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.75));
			const nextHeight = currentHeight === 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.75));
			if (nextWidth === currentWidth && nextHeight === currentHeight) {
				break;
			}

			currentWidth = nextWidth;
			currentHeight = nextHeight;
		}

		return null;
	} catch {
		return null;
	} finally {
		if (image) {
			image.free();
		}
	}
}
