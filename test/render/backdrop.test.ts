import { boxBlur, coverFit, saturate, type Rgba } from "../../src/art/image";
import type { Rgb } from "../../src/art/accent";
import { buildBackdrop, buildTakeoverPlate } from "../../src/render/backdrop";
import { decodeDataUri } from "../helpers/compose";
import { make } from "../helpers/synth";

const px = (img: Rgba, x: number, y: number) => {
	const o = (y * img.width + x) * 4;
	return Array.from(img.data.subarray(o, o + 4));
};

/** Smooth two-axis gradient with a distinct centre, so the thumbnail and the blur are both checkable. */
const cover = make(300, 300, (x, y) => [Math.round((x / 299) * 255), Math.round((y / 299) * 200) + 30, 90]);
const accent: Rgb = [200, 120, 40];

describe("buildBackdrop", () => {
	test("returns a PNG data URI that decodes to 200x100", () => {
		for (const c of [cover, null]) {
			const uri = buildBackdrop(c, accent);
			expect(uri.startsWith("data:image/png;base64,")).toBe(true);
			const img = decodeDataUri(uri);
			expect([img.width, img.height]).toEqual([200, 100]);
		}
	});

	test("the thumbnail centre is the cover's centre colour, sharp and unscrimmed", () => {
		const img = decodeDataUri(buildBackdrop(cover, accent));
		const centre = px(cover, 150, 150);
		const got = px(img, 37, 37);
		for (let c = 0; c < 3; c++) expect(Math.abs(got[c] - centre[c])).toBeLessThanOrEqual(12);
		expect(got[3]).toBe(255);
	});

	test("the backdrop is the blurred, saturated cover under a 0.45 scrim", () => {
		const img = decodeDataUri(buildBackdrop(cover, accent));
		// The 240x240 fit sits at (-20, -70), so strip (150, 50) is fitted (170, 120).
		const blurred = saturate(boxBlur(coverFit(cover, 240, 240), 10, 3), 1.25);
		const ref = px(blurred, 170, 120);
		const got = px(img, 150, 50);
		for (let c = 0; c < 3; c++) {
			const want = ref[c] * 0.55;
			expect(got[c]).toBeLessThan(ref[c]);
			expect(Math.abs(got[c] - want)).toBeLessThanOrEqual(Math.max(2, want * 0.1));
		}
		expect(got[3]).toBe(255);
	});

	test("the thumbnail corners are rounded and anti-aliased", () => {
		// A white cover: the backdrop is white under the scrim (255 x 0.55 = 140), the thumbnail white.
		const img = decodeDataUri(buildBackdrop(make(300, 300, () => [255, 255, 255]), accent));
		// The corner pixel lies outside the 6 px radius; the edge midpoints are inside.
		expect(px(img, 8, 8)[0]).toBeLessThanOrEqual(145);
		expect(px(img, 37, 8)[0]).toBeGreaterThan(250);
		expect(px(img, 8, 37)[0]).toBeGreaterThan(250);
		// Somewhere on the corner arc there is a partially covered pixel.
		const arc = [px(img, 9, 10)[0], px(img, 10, 9)[0], px(img, 9, 9)[0], px(img, 10, 10)[0]];
		expect(arc.some((v) => v > 150 && v < 245)).toBe(true);
	});

	test("with no cover: an accent gradient from 0.30 to 0.10 and a 0.55 placeholder thumbnail", () => {
		const img = decodeDataUri(buildBackdrop(null, accent));
		const top = px(img, 100, 5);
		const bottom = px(img, 100, 95);
		const thumb = px(img, 37, 37);
		for (let c = 0; c < 3; c++) {
			expect(Math.abs(top[c] - accent[c] * 0.3)).toBeLessThanOrEqual(8);
			expect(Math.abs(bottom[c] - accent[c] * 0.1)).toBeLessThanOrEqual(8);
			expect(Math.abs(thumb[c] - accent[c] * 0.55)).toBeLessThanOrEqual(2);
		}
		expect(top[3]).toBe(255);
		// Placeholder keeps the rounded corner too.
		expect(px(img, 8, 8)[0]).toBeLessThan(accent[0] * 0.4);
	});
});

// Ruling R20: the takeover's backdrop, as the predecessor painted it — the blurred, saturated
// cover with no thumbnail under black 0.62 (x 0.38), or the plain accent gradient with no cover.
describe("buildTakeoverPlate", () => {
	/** Mean of the 2x2 block of `img` whose top-left is (x, y). */
	const block = (img: Rgba, x: number, y: number) =>
		[0, 1, 2].map((c) => (px(img, x, y)[c] + px(img, x + 1, y)[c] + px(img, x, y + 1)[c] + px(img, x + 1, y + 1)[c]) / 4);

	test("returns a half-resolution PNG data URI, 100x50, fully opaque", () => {
		for (const c of [cover, null]) {
			const uri = buildTakeoverPlate(c, accent);
			expect(uri.startsWith("data:image/png;base64,")).toBe(true);
			const img = decodeDataUri(uri);
			expect([img.width, img.height]).toEqual([100, 50]);
			for (let i = 3; i < img.data.length; i += 4) expect(img.data[i]).toBe(255);
		}
	});

	test("is the blurred, saturated cover at x 0.38, with no thumbnail", () => {
		const img = decodeDataUri(buildTakeoverPlate(cover, accent));
		const blurred = saturate(boxBlur(coverFit(cover, 240, 240), 10, 3), 1.25);
		// Plate (x, y) covers strip (2x, 2y)..(2x+1, 2y+1), which is fitted (2x+20, 2y+70).
		for (const [x, y] of [
			[75, 25],
			[18, 18], // over the thumbnail: blur, not the sharp cover
			[5, 45]
		]) {
			const want = block(blurred, 2 * x + 20, 2 * y + 70).map((v) => v * 0.38);
			const got = px(img, x, y);
			for (let c = 0; c < 3; c++) expect(Math.abs(got[c] - want[c])).toBeLessThanOrEqual(2);
		}
	});

	test("with no cover: the accent gradient from 0.30 to 0.10 with no placeholder and no scrim", () => {
		const img = decodeDataUri(buildTakeoverPlate(null, accent));
		for (const y of [2, 18, 47]) {
			// Plate row y spans strip rows 2y and 2y+1, whose centres average to 2y + 1.
			const k = 0.3 + (0.1 - 0.3) * ((2 * y + 1) / 100);
			const got = px(img, 18, y);
			for (let c = 0; c < 3; c++) expect(Math.abs(got[c] - accent[c] * k)).toBeLessThanOrEqual(1);
		}
	});

	test("stays small enough to embed in takeover frames", () => {
		// The plate rides in every takeover fg frame, URI-encoded inside the SVG.
		const uri = buildTakeoverPlate(cover, accent);
		expect(encodeURIComponent(uri).length).toBeLessThan(16_000);
	});
});
