// The `bg` layer: built once per cover and accent, sent only when either changes.
import type { Rgb } from "../art/accent";
import { boxBlur, coverFit, encodePng, resizeArea, saturate, type Rgba } from "../art/image";
import { STRIP_H, STRIP_W } from "./geometry";

/** The cover is fitted to a square 40 px wider than the strip and centred on it, as in the predecessor. */
const FIT_MARGIN = 20;
const BLUR_RADIUS = 10;
const BLUR_PASSES = 3;
const SATURATION = 1.25;
// Raised from the original 0.45 to 0.55 for contrast after testing on hardware, so the text and volume bar stand out.
const SCRIM = 0.55;

type Thumb = { x: number; y: number; size: number; radius: number };
const THUMB: Thumb = { x: 8, y: 8, size: 58, radius: 6 };
/** The Wide pair's bigger thumbnail. */
export const WIDE_THUMB: Thumb = { x: 8, y: 8, size: 62, radius: 7 };
/** The Wide pair's full width: two strip segments side by side. */
export const WIDE_W = STRIP_W * 2;
/** With no cover: a vertical accent gradient, and a flat accent placeholder for the thumbnail. */
const GRADIENT_TOP = 0.3;
const GRADIENT_BOTTOM = 0.1;
const PLACEHOLDER = 0.55;
/**
 * The takeover plate: the predecessor repainted the blurred cover without the
 * thumbnail, then black at 0.62, so the cover keeps 0.38. With no cover it repainted the bare
 * gradient. Half resolution is enough for a blur this wide; the fg scales it to the strip.
 */
const PLATE_KEEP = 0.38;
const PLATE_W = STRIP_W / 2;
const PLATE_H = STRIP_H / 2;

const dataUri = (img: Rgba) => `data:image/png;base64,${Buffer.from(encodePng(img)).toString("base64")}`;

/** The strip backdrop as a `data:image/png;base64,...` URI, 200×100. */
export function buildBackdrop(cover: Rgba | null, accent: Rgb): string {
	if (!cover) {
		const strip = accentGradient(accent, STRIP_W, STRIP_H);
		drawThumbnail(strip, placeholder(accent));
		return dataUri(strip);
	}
	const strip = blurredStrip(cover, 1 - SCRIM);
	drawThumbnail(strip, coverFit(cover, THUMB.size, THUMB.size));
	return dataUri(strip);
}

/**
 * The Wide pair's backdrop, built 400×100 and cut at x = 200 into the left and right halves'
 * `data:image/png;base64,...` URIs, so the two strip segments read as one picture.
 */
export function buildWideBackdrop(cover: Rgba | null, accent: Rgb): [string, string] {
	const wide = cover ? blurredStrip(cover, 1 - SCRIM, WIDE_W) : accentGradient(accent, WIDE_W, STRIP_H);
	drawThumbnail(wide, cover ? coverFit(cover, WIDE_THUMB.size, WIDE_THUMB.size) : placeholder(accent, WIDE_THUMB.size), WIDE_THUMB);
	return [dataUri(crop(wide, 0, STRIP_W)), dataUri(crop(wide, STRIP_W, STRIP_W))];
}

/** Columns x0..x0+w of `img`, full height. */
function crop(img: Rgba, x0: number, w: number): Rgba {
	const data = new Uint8Array(w * img.height * 4);
	for (let y = 0; y < img.height; y++) {
		const from = (y * img.width + x0) * 4;
		data.set(img.data.subarray(from, from + w * 4), y * w * 4);
	}
	return { width: w, height: img.height, data };
}

/** The takeover plate as a `data:image/png;base64,...` URI, 100×50: the backdrop without its thumbnail, at x 0.38. */
export function buildTakeoverPlate(cover: Rgba | null, accent: Rgb): string {
	if (!cover) return dataUri(accentGradient(accent, PLATE_W, PLATE_H));
	return dataUri(resizeArea(blurredStrip(cover, PLATE_KEEP), PLATE_W, PLATE_H));
}

/** The strip-sized (`width`×STRIP_H) window of the blurred, saturated cover fit, with each channel scaled by `keep`. */
function blurredStrip(cover: Rgba, keep: number, width = STRIP_W): Rgba {
	const side = width + 2 * FIT_MARGIN;
	const fitX = -FIT_MARGIN;
	const fitY = (STRIP_H - side) / 2;
	const fitted = saturate(boxBlur(coverFit(cover, side, side), BLUR_RADIUS, BLUR_PASSES), SATURATION);
	const data = new Uint8Array(width * STRIP_H * 4);
	for (let y = 0; y < STRIP_H; y++) {
		for (let x = 0; x < width; x++) {
			const s = ((y - fitY) * side + (x - fitX)) * 4;
			const o = (y * width + x) * 4;
			data[o] = Math.round(fitted.data[s] * keep);
			data[o + 1] = Math.round(fitted.data[s + 1] * keep);
			data[o + 2] = Math.round(fitted.data[s + 2] * keep);
			data[o + 3] = 255;
		}
	}
	return { width, height: STRIP_H, data };
}

/** A vertical accent gradient, accent x 0.30 at the top to x 0.10 at the bottom, at any size. */
function accentGradient(accent: Rgb, width: number, height: number): Rgba {
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		const k = GRADIENT_TOP + (GRADIENT_BOTTOM - GRADIENT_TOP) * ((y + 0.5) / height);
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4;
			data[o] = Math.round(accent[0] * k);
			data[o + 1] = Math.round(accent[1] * k);
			data[o + 2] = Math.round(accent[2] * k);
			data[o + 3] = 255;
		}
	}
	return { width, height, data };
}

/** The no-cover thumbnail: flat accent x 0.55. */
function placeholder(accent: Rgb, size = THUMB.size): Rgba {
	const fill = accent.map((c) => Math.round(c * PLACEHOLDER));
	const data = new Uint8Array(size * size * 4);
	for (let i = 0; i < data.length; i += 4) data.set([fill[0], fill[1], fill[2], 255], i);
	return { width: size, height: size, data };
}

/**
 * Coverage of the thumbnail's rounded rect at pixel (px, py) of the thumbnail, 0..1:
 * the signed distance from the pixel centre to the shape, as a 1 px anti-aliased edge.
 */
function roundedCoverage(px: number, py: number, thumb: Thumb): number {
	const half = thumb.size / 2;
	const inner = half - thumb.radius;
	const qx = Math.abs(px + 0.5 - half) - inner;
	const qy = Math.abs(py + 0.5 - half) - inner;
	const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
	const d = outside + Math.min(Math.max(qx, qy), 0) - thumb.radius;
	return Math.min(Math.max(0.5 - d, 0), 1);
}

/** Composites a `box.size` square image onto the strip at box.x/y through the rounded mask. */
function drawThumbnail(strip: Rgba, thumb: Rgba, box: Thumb = THUMB) {
	for (let y = 0; y < box.size; y++) {
		for (let x = 0; x < box.size; x++) {
			const t = (y * box.size + x) * 4;
			const a = roundedCoverage(x, y, box) * (thumb.data[t + 3] / 255);
			if (a === 0) continue;
			const o = ((box.y + y) * strip.width + box.x + x) * 4;
			for (let c = 0; c < 3; c++) strip.data[o + c] = Math.round(thumb.data[t + c] * a + strip.data[o + c] * (1 - a));
		}
	}
}
