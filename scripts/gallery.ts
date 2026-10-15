// Shared by the README image scripts (render-screenshots.ts and compose-captures.ts): the device
// composition rasterised at 3x, PNG output without metadata, and the GIF encoder.
import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { PNG } from "pngjs";
import type { Rgba } from "../src/art/image";
import { composeSingle } from "../src/render/foreground";

type GifEncoder = {
	writeFrame(index: Uint8Array, width: number, height: number, opts: Record<string, unknown>): void;
	finish(): void;
	bytes(): Uint8Array;
};
type GifEnc = {
	GIFEncoder(): GifEncoder;
	quantize(rgba: Uint8Array, maxColors: number, opts?: Record<string, unknown>): number[][];
	applyPalette(rgba: Uint8Array, palette: number[][], format?: string): Uint8Array;
};
// gifenc's CommonJS bundle hides its named exports from Node's ESM loader, so load it via require.
const { GIFEncoder, quantize, applyPalette } = createRequire(import.meta.url)("gifenc") as GifEnc;

export const OUT = path.resolve(import.meta.dirname, "..", "docs", "images");
export const SCALE = 3;
export const WIDTH = 200 * SCALE;
export const HEIGHT = 100 * SCALE;
/** The machine's system fonts, so `Segoe UI` and the CJK fallback (Yu Gothic UI on Windows) match the deck. */
export const FONT = { loadSystemFonts: true, defaultFontFamily: "Segoe UI", sansSerifFamily: "Segoe UI" };

/**
 * What the strip shows, at 3x: the bg PNG under the fg SVG, as one SVG with the backdrop embedded
 * as an <image> (resvg scales it up smoothly), rasterised by resvg to `width` px (default 600).
 */
export function rasterise(bgUri: string, fgSvg: string, width = WIDTH): Rgba {
	const resvg = new Resvg(composeSingle(bgUri, fgSvg), { fitTo: { mode: "width", value: width }, font: FONT });
	// asPng() demultiplies alpha; decoding it gives straight RGBA.
	const png = PNG.sync.read(resvg.render().asPng());
	return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

/** Writes through pngjs, which emits no text or metadata chunks (the scrub checks). */
export function writePng(name: string, img: Rgba): void {
	const png = new PNG({ width: img.width, height: img.height });
	png.data = Buffer.from(img.data);
	const file = path.join(OUT, name);
	fs.writeFileSync(file, PNG.sync.write(png, { colorType: 2 }));
	console.log(`${path.relative(process.cwd(), file)} (${img.width}x${img.height})`);
}

export function writeGif(name: string, frames: Rgba[], frameMs: number): void {
	const gif = encodeGif(frames, frameMs);
	const file = path.join(OUT, name);
	fs.writeFileSync(file, gif);
	console.log(`${path.relative(process.cwd(), file)} (${WIDTH}x${HEIGHT}, ${frames.length} frames, ${Math.round(gif.length / 1024)} KB)`);
}

/** 4x4 Bayer matrix: a fixed dither pattern, so unchanged pixels stay identical between frames. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** Peak-to-peak dither amplitude, in 8-bit levels; enough to break up banding in the blurred backdrop. */
const DITHER = 10;
/** The palette is built from at most this many frames, evenly spaced, to bound memory for long clips. */
const PALETTE_FRAMES = 30;

function ordered(img: Rgba): Uint8Array {
	const out = new Uint8Array(img.data);
	for (let y = 0; y < img.height; y++) {
		for (let x = 0; x < img.width; x++) {
			const d = (BAYER[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * DITHER;
			const o = (y * img.width + x) * 4;
			for (let c = 0; c < 3; c++) out[o + c] = Math.min(255, Math.max(0, Math.round(img.data[o + c] + d)));
		}
	}
	return out;
}

/**
 * One global palette for every frame (no shimmer between frames), an ordered dither against
 * banding, and every pixel unchanged since the previous frame written as transparent over it,
 * so static areas cost almost nothing.
 */
function encodeGif(frames: Rgba[], frameMs: number): Uint8Array {
	const step = Math.max(1, Math.ceil(frames.length / PALETTE_FRAMES));
	const sample = frames.filter((_, i) => i % step === 0);
	const all = new Uint8Array(sample.length * frames[0].data.length);
	sample.forEach((f, i) => all.set(f.data, i * f.data.length));
	const palette = quantize(all, 255);
	const transparentIndex = palette.length;
	palette.push([0, 0, 0]);
	const gif = GIFEncoder();
	let prev: Uint8Array | null = null;
	for (const f of frames) {
		const index = applyPalette(ordered(f), palette);
		const out = Uint8Array.from(index);
		if (prev) for (let p = 0; p < out.length; p++) if (index[p] === prev[p]) out[p] = transparentIndex;
		gif.writeFrame(out, f.width, f.height, {
			...(prev ? {} : { palette }),
			delay: frameMs,
			transparent: prev !== null,
			transparentIndex,
			dispose: 1
		});
		prev = index;
	}
	gif.finish();
	return gif.bytes();
}
