// Pure-JS image pipeline: decode, resample, blur, saturate, encode. No native
// modules. Every function returns a new Rgba and never mutates its input.
import { decode as decodeJpeg } from "jpeg-js";
import { PNG } from "pngjs";

/** RGBA8, row-major, 4 bytes per pixel. */
export type Rgba = { width: number; height: number; data: Uint8Array };

export class UnsupportedImageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsupportedImageError";
	}
}

// Bounds for hostile or oversized covers: refuse rather than allocate or spin.
const MAX_JPEG_MEGAPIXELS = 25;
const MAX_JPEG_MEMORY_MB = 256;
/** A real progressive JPEG has about 10 scans; jpeg-js walks every block once per scan, with no limit of its own. */
const MAX_JPEG_SCANS = 100;
/** A decoded PNG is held three times over (pngjs, the composite, the coverFit crop): 16 MP peaks near 200 MB. */
const MAX_PNG_MEGAPIXELS = 16;
const MAX_PNG_PIXELS = MAX_PNG_MEGAPIXELS * 1_000_000;
/** A real PNG has a handful of chunks; the cap keeps the chunk walk itself cheap on hostile files. */
const MAX_PNG_CHUNKS = 10_000;
const PNG_SIGNATURE_LENGTH = 8;

const isJpeg = (b: Uint8Array) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b: Uint8Array) => b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Sniffs the magic bytes (FFD8FF = JPEG, 89504E47 = PNG); anything else throws UnsupportedImageError. */
export function decodeImage(bytes: Uint8Array): Rgba {
	if (isJpeg(bytes)) return decodeJpegBytes(bytes);
	if (isPng(bytes)) return decodePngBytes(bytes);
	throw new UnsupportedImageError("Unsupported image format: only JPEG and PNG are handled");
}

/**
 * Counts SOS markers (FF DA). Entropy-coded data stuffs every FF as FF 00, so outside other
 * segments' payloads this is exact; a marker-shaped pair inside a payload only overcounts.
 */
function countScans(bytes: Uint8Array): number {
	let n = 0;
	for (let i = bytes.indexOf(0xff); i >= 0 && i < bytes.length - 1; i = bytes.indexOf(0xff, i + 1)) {
		if (bytes[i + 1] === 0xda) n++;
	}
	return n;
}

function decodeJpegBytes(bytes: Uint8Array): Rgba {
	// jpeg-js bounds memory but not time: thousands of tiny progressive scans would hold the
	// plugin's only thread for minutes. Counting is linear and runs before any decoding.
	if (countScans(bytes) > MAX_JPEG_SCANS) throw new UnsupportedImageError(`JPEG has more than ${MAX_JPEG_SCANS} scans`);
	let out;
	try {
		out = decodeJpeg(bytes, {
			maxResolutionInMP: MAX_JPEG_MEGAPIXELS,
			maxMemoryUsageInMB: MAX_JPEG_MEMORY_MB,
			formatAsRGBA: true,
			useTArray: true
		});
	} catch (e) {
		throw new Error(`JPEG decode failed: ${message(e)}`);
	}
	// With no entropy data jpeg-js accepts a 0-sized frame and returns an empty image.
	if (out.width === 0 || out.height === 0) throw new UnsupportedImageError("JPEG has a zero width or height");
	return { width: out.width, height: out.height, data: out.data };
}

/**
 * Walks the PNG chunk list (length, type, data, CRC) and checks the one IHDR before pngjs sees any
 * of it. pngjs re-parses every IHDR it meets and keeps the last, so a benign first header must not
 * be allowed to hide a later interlaced or oversized one: exactly one IHDR, and it comes first.
 * Every step is bounds-checked, and the walk is capped, so it stays linear and cheap.
 */
function checkPngChunks(bytes: Uint8Array): void {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let pos = PNG_SIGNATURE_LENGTH;
	for (let count = 1; ; count++) {
		if (count > MAX_PNG_CHUNKS) throw new UnsupportedImageError(`PNG has too many chunks (more than ${MAX_PNG_CHUNKS})`);
		if (pos + 8 > bytes.length) throw new UnsupportedImageError("PNG is truncated before IEND");
		const length = dv.getUint32(pos);
		const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
		const next = pos + 12 + length; // length + type + data + CRC
		if (next > bytes.length) throw new UnsupportedImageError("PNG is truncated inside a chunk");
		if (count === 1) {
			if (type !== "IHDR" || length !== 13) throw new UnsupportedImageError("PNG first chunk is not a valid IHDR");
			// The spec forbids a zero dimension, and 0 x anything slips under the pixel cap while pngjs
			// still allocates for the other axis (a 68-byte file with height 4294967295 aborts V8).
			const width = dv.getUint32(pos + 8);
			const height = dv.getUint32(pos + 12);
			if (width === 0 || height === 0) throw new UnsupportedImageError("PNG has a zero width or height");
			// pngjs allocates width*height*4 as soon as it has read the header: check the size first.
			if (width * height > MAX_PNG_PIXELS) {
				throw new Error(`PNG decode failed: image exceeds ${MAX_PNG_MEGAPIXELS} megapixels`);
			}
			// The interlace method is IHDR's last byte. pngjs inflates Adam7 data with no output bound, so a
			// small interlaced file can inflate to gigabytes: refuse it (the fallback is the accent gradient).
			if (bytes[pos + 8 + 12] === 1) throw new UnsupportedImageError("interlaced PNG");
		} else if (type === "IHDR") {
			throw new UnsupportedImageError("PNG has more than one IHDR");
		}
		if (type === "IEND") return;
		pos = next;
	}
}

function decodePngBytes(bytes: Uint8Array): Rgba {
	checkPngChunks(bytes);
	try {
		const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
		const data = new Uint8Array(png.width * png.height * 4);
		// Composite onto black: rgb * a / 255, output alpha 255.
		for (let i = 0; i < data.length; i += 4) {
			const a = png.data[i + 3];
			if (a === 255) {
				data[i] = png.data[i];
				data[i + 1] = png.data[i + 1];
				data[i + 2] = png.data[i + 2];
			} else {
				data[i] = Math.round((png.data[i] * a) / 255);
				data[i + 1] = Math.round((png.data[i + 1] * a) / 255);
				data[i + 2] = Math.round((png.data[i + 2] * a) / 255);
			}
			data[i + 3] = 255;
		}
		return { width: png.width, height: png.height, data };
	} catch (e) {
		throw new Error(`PNG decode failed: ${message(e)}`);
	}
}

export function encodePng(img: Rgba): Uint8Array {
	const png = new PNG({ width: img.width, height: img.height });
	png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
	return Uint8Array.from(PNG.sync.write(png));
}

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

type Tap = { start: number; weights: Float32Array };

/**
 * Per-axis resampling taps. Shrinking averages every source sample under the
 * destination pixel, weighted by overlap (area average); growing interpolates
 * linearly between pixel centres.
 */
function taps(srcLen: number, dstLen: number): Tap[] {
	const out: Tap[] = [];
	const scale = srcLen / dstLen;
	for (let i = 0; i < dstLen; i++) {
		if (scale >= 1) {
			const from = i * scale;
			const to = from + scale;
			const start = Math.floor(from);
			const end = Math.min(Math.ceil(to), srcLen);
			const weights = new Float32Array(end - start);
			for (let s = start; s < end; s++) {
				weights[s - start] = (Math.min(s + 1, to) - Math.max(s, from)) / scale;
			}
			out.push({ start, weights });
		} else {
			const centre = (i + 0.5) * scale - 0.5;
			const lo = Math.floor(centre);
			const f = centre - lo;
			const a = Math.min(Math.max(lo, 0), srcLen - 1);
			const b = Math.min(Math.max(lo + 1, 0), srcLen - 1);
			out.push(a === b ? { start: a, weights: Float32Array.of(1) } : { start: a, weights: Float32Array.of(1 - f, f) });
		}
	}
	return out;
}

/** Area-average downscale (bilinear when upscaling), per axis. */
export function resizeArea(src: Rgba, w: number, h: number): Rgba {
	if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
		throw new RangeError(`resizeArea: target size must be positive integers, got ${w}x${h}`);
	}
	if (src.width < 1 || src.height < 1) throw new RangeError("resizeArea: source image is empty");

	const xTaps = taps(src.width, w);
	const yTaps = taps(src.height, h);

	// Horizontal pass into floats (src.height rows of w pixels), then vertical.
	const mid = new Float32Array(w * src.height * 4);
	for (let y = 0; y < src.height; y++) {
		const row = y * src.width * 4;
		for (let x = 0; x < w; x++) {
			const { start, weights } = xTaps[x];
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			for (let k = 0; k < weights.length; k++) {
				const o = row + (start + k) * 4;
				const wt = weights[k];
				r += src.data[o] * wt;
				g += src.data[o + 1] * wt;
				b += src.data[o + 2] * wt;
				a += src.data[o + 3] * wt;
			}
			const m = (y * w + x) * 4;
			mid[m] = r;
			mid[m + 1] = g;
			mid[m + 2] = b;
			mid[m + 3] = a;
		}
	}

	const data = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++) {
		const { start, weights } = yTaps[y];
		for (let x = 0; x < w; x++) {
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			for (let k = 0; k < weights.length; k++) {
				const m = ((start + k) * w + x) * 4;
				const wt = weights[k];
				r += mid[m] * wt;
				g += mid[m + 1] * wt;
				b += mid[m + 2] * wt;
				a += mid[m + 3] * wt;
			}
			const o = (y * w + x) * 4;
			data[o] = clamp8(r);
			data[o + 1] = clamp8(g);
			data[o + 2] = clamp8(b);
			data[o + 3] = clamp8(a);
		}
	}
	return { width: w, height: h, data };
}

/** Centre-crop to the target aspect ratio, then resizeArea. */
export function coverFit(src: Rgba, w: number, h: number): Rgba {
	let cropW = src.width;
	let cropH = src.height;
	if (src.width * h > src.height * w) {
		cropW = Math.min(src.width, Math.max(1, Math.round((src.height * w) / h)));
	} else {
		cropH = Math.min(src.height, Math.max(1, Math.round((src.width * h) / w)));
	}
	const x0 = Math.floor((src.width - cropW) / 2);
	const y0 = Math.floor((src.height - cropH) / 2);
	const cropped = new Uint8Array(cropW * cropH * 4);
	for (let y = 0; y < cropH; y++) {
		const from = ((y0 + y) * src.width + x0) * 4;
		cropped.set(src.data.subarray(from, from + cropW * 4), y * cropW * 4);
	}
	return resizeArea({ width: cropW, height: cropH, data: cropped }, w, h);
}

/** One 1-D box blur of a float plane, edges clamped. `len` samples, `stride` apart, `count` lines. */
function blurLines(buf: Float32Array, len: number, lineStep: number, count: number, stride: number, radius: number) {
	const win = 2 * radius + 1;
	const line = new Float32Array(len);
	for (let c = 0; c < count; c++) {
		const base = c * lineStep;
		for (let i = 0; i < len; i++) line[i] = buf[base + i * stride];
		let sum = 0;
		for (let k = -radius; k <= radius; k++) sum += line[Math.min(Math.max(k, 0), len - 1)];
		for (let i = 0; i < len; i++) {
			buf[base + i * stride] = sum / win;
			sum += line[Math.min(i + radius + 1, len - 1)] - line[Math.max(i - radius, 0)];
		}
	}
}

/** Separable box blur, `passes` times (default 3, which approximates a Gaussian). */
export function boxBlur(src: Rgba, radius: number, passes = 3): Rgba {
	const r = Math.max(0, Math.floor(radius));
	if (r === 0 || passes < 1 || src.width < 1 || src.height < 1) return { ...src, data: Uint8Array.from(src.data) };
	const { width, height } = src;
	const out = new Uint8Array(width * height * 4);
	const plane = new Float32Array(width * height);
	for (let ch = 0; ch < 4; ch++) {
		for (let i = 0; i < plane.length; i++) plane[i] = src.data[i * 4 + ch];
		for (let p = 0; p < passes; p++) {
			blurLines(plane, width, width, height, 1, r);
			blurLines(plane, height, 1, width, width, r);
		}
		for (let i = 0; i < plane.length; i++) out[i * 4 + ch] = clamp8(plane[i]);
	}
	return { width, height, data: out };
}

/** Scales each pixel's distance from its luma by `factor` (0 = greyscale, 1 = unchanged). */
export function saturate(src: Rgba, factor: number): Rgba {
	const data = new Uint8Array(src.data.length);
	for (let i = 0; i < data.length; i += 4) {
		const r = src.data[i];
		const g = src.data[i + 1];
		const b = src.data[i + 2];
		const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		data[i] = clamp8(luma + (r - luma) * factor);
		data[i + 1] = clamp8(luma + (g - luma) * factor);
		data[i + 2] = clamp8(luma + (b - luma) * factor);
		data[i + 3] = src.data[i + 3];
	}
	return { width: src.width, height: src.height, data };
}
