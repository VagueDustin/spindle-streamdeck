// Synthetic images for the art tests: generated in code, never album covers.
import { encode } from "jpeg-js";
import type { Rgba } from "../../src/art/image";

export { encodePng } from "../../src/art/image";

type Rgb = [number, number, number];

/** A w×h image where pixel (x, y) is produced by `fn`. Alpha is 255 unless fn returns a fourth value. */
export function make(
	width: number,
	height: number,
	fn: (x: number, y: number) => Rgb | [number, number, number, number]
): Rgba {
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b, a = 255] = fn(x, y);
			const o = (y * width + x) * 4;
			data[o] = r;
			data[o + 1] = g;
			data[o + 2] = b;
			data[o + 3] = a;
		}
	}
	return { width, height, data };
}

export function solid(rgb: Rgb, size = 96): Rgba {
	return make(size, size, () => rgb);
}

/**
 * A `base` field with a `patch` colour covering `share` of the pixels (the
 * first rows, so the patch is one contiguous block). 96×96, so the picker
 * does no resampling.
 */
export function field(base: Rgb, opts: { patch: Rgb; share: number }, size = 96): Rgba {
	const cut = Math.round(opts.share * size * size);
	return make(size, size, (x, y) => (y * size + x < cut ? opts.patch : base));
}

/** Horizontal black-to-white ramp: every pixel is grey. */
export function greyRamp(size = 96): Rgba {
	return make(size, size, (x) => {
		const v = Math.round((x / (size - 1)) * 255);
		return [v, v, v];
	});
}

/** An HSV hue (degrees) as a fully saturated, full-value RGB triple. */
function hueRgb(deg: number): Rgb {
	const h6 = (((deg % 360) + 360) % 360) / 60;
	const i = Math.floor(h6);
	const f = h6 - i;
	const [p, q, t] = [0, 1 - f, f];
	const rgb = [
		[1, t, p],
		[q, 1, p],
		[p, 1, t],
		[p, q, 1],
		[t, p, 1],
		[1, p, q]
	][i % 6];
	return rgb.map((c) => Math.round(c * 255)) as Rgb;
}

/** Half the pixels at hue `a`, half at hue `b` (degrees), alternating. */
export function twoHue(a: number, b: number, size = 96): Rgba {
	const [ca, cb] = [hueRgb(a), hueRgb(b)];
	return make(size, size, (x, y) => ((x + y) % 2 === 0 ? ca : cb));
}

/** A smooth RGB gradient: compresses well, so big JPEGs stay quick to encode. */
export function gradient(width: number, height: number): Rgba {
	return make(width, height, (x, y) => [
		Math.round((x / width) * 255),
		Math.round((y / height) * 255),
		128
	]);
}

export function encodeJpeg(img: Rgba, quality = 90): Uint8Array {
	return Uint8Array.from(encode({ width: img.width, height: img.height, data: img.data }, quality).data);
}
