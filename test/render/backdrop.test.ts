import { boxBlur, coverFit, saturate, type Rgba } from "../../src/art/image";
import type { Rgb } from "../../src/art/accent";
import { buildBackdrop } from "../../src/render/backdrop";
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
