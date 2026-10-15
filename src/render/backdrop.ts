// The `bg` layer (spec 4.2): built once per cover and accent, sent only when either changes.
import type { Rgb } from "../art/accent";
import { boxBlur, coverFit, encodePng, saturate, type Rgba } from "../art/image";
import { STRIP_H, STRIP_W } from "./geometry";

/** The cover is fitted to a square wider than the strip and centred on it, as in the predecessor. */
const FIT_SIDE = STRIP_W + 40;
const FIT_X = -20;
const FIT_Y = (STRIP_H - FIT_SIDE) / 2;
const BLUR_RADIUS = 10;
const BLUR_PASSES = 3;
const SATURATION = 1.25;
const SCRIM = 0.45;

const THUMB = { x: 8, y: 8, size: 58, radius: 6 };
/** With no cover: a vertical accent gradient, and a flat accent placeholder for the thumbnail. */
const GRADIENT_TOP = 0.3;
const GRADIENT_BOTTOM = 0.1;
const PLACEHOLDER = 0.55;

/** The strip backdrop as a `data:image/png;base64,...` URI, 200×100. */
export function buildBackdrop(cover: Rgba | null, accent: Rgb): string {
	const img = cover ? coverBackdrop(cover) : accentBackdrop(accent);
	return `data:image/png;base64,${Buffer.from(encodePng(img)).toString("base64")}`;
}

function coverBackdrop(cover: Rgba): Rgba {
	const fitted = saturate(boxBlur(coverFit(cover, FIT_SIDE, FIT_SIDE), BLUR_RADIUS, BLUR_PASSES), SATURATION);
	const data = new Uint8Array(STRIP_W * STRIP_H * 4);
	const keep = 1 - SCRIM;
	for (let y = 0; y < STRIP_H; y++) {
		for (let x = 0; x < STRIP_W; x++) {
			const s = ((y - FIT_Y) * FIT_SIDE + (x - FIT_X)) * 4;
			const o = (y * STRIP_W + x) * 4;
			data[o] = Math.round(fitted.data[s] * keep);
			data[o + 1] = Math.round(fitted.data[s + 1] * keep);
			data[o + 2] = Math.round(fitted.data[s + 2] * keep);
			data[o + 3] = 255;
		}
	}
	const strip = { width: STRIP_W, height: STRIP_H, data };
	drawThumbnail(strip, coverFit(cover, THUMB.size, THUMB.size));
	return strip;
}

function accentBackdrop(accent: Rgb): Rgba {
	const data = new Uint8Array(STRIP_W * STRIP_H * 4);
	for (let y = 0; y < STRIP_H; y++) {
		const k = GRADIENT_TOP + (GRADIENT_BOTTOM - GRADIENT_TOP) * ((y + 0.5) / STRIP_H);
		for (let x = 0; x < STRIP_W; x++) {
			const o = (y * STRIP_W + x) * 4;
			data[o] = Math.round(accent[0] * k);
			data[o + 1] = Math.round(accent[1] * k);
			data[o + 2] = Math.round(accent[2] * k);
			data[o + 3] = 255;
		}
	}
	const strip = { width: STRIP_W, height: STRIP_H, data };
	const fill = accent.map((c) => Math.round(c * PLACEHOLDER));
	const placeholder = new Uint8Array(THUMB.size * THUMB.size * 4);
	for (let i = 0; i < placeholder.length; i += 4) placeholder.set([fill[0], fill[1], fill[2], 255], i);
	drawThumbnail(strip, { width: THUMB.size, height: THUMB.size, data: placeholder });
	return strip;
}

/**
 * Coverage of the thumbnail's rounded rect at pixel (px, py) of the thumbnail, 0..1:
 * the signed distance from the pixel centre to the shape, as a 1 px anti-aliased edge.
 */
function roundedCoverage(px: number, py: number): number {
	const half = THUMB.size / 2;
	const inner = half - THUMB.radius;
	const qx = Math.abs(px + 0.5 - half) - inner;
	const qy = Math.abs(py + 0.5 - half) - inner;
	const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
	const d = outside + Math.min(Math.max(qx, qy), 0) - THUMB.radius;
	return Math.min(Math.max(0.5 - d, 0), 1);
}

/** Composites a THUMB.size square image onto the strip at THUMB.x/y through the rounded mask. */
function drawThumbnail(strip: Rgba, thumb: Rgba) {
	for (let y = 0; y < THUMB.size; y++) {
		for (let x = 0; x < THUMB.size; x++) {
			const t = (y * THUMB.size + x) * 4;
			const a = roundedCoverage(x, y) * (thumb.data[t + 3] / 255);
			if (a === 0) continue;
			const o = ((THUMB.y + y) * STRIP_W + THUMB.x + x) * 4;
			for (let c = 0; c < 3; c++) strip.data[o + c] = Math.round(thumb.data[t + c] * a + strip.data[o + c] * (1 - a));
		}
	}
}
