import { FALLBACK_ACCENT, pickAccent, pyRound, type Rgb } from "../../src/art/accent";
import { field, greyRamp, make, solid, twoHue } from "../helpers/synth";

/** HLS with hue in degrees and l/s in 0-1, computed independently of the implementation. */
function hls(r: number, g: number, b: number) {
	const [R, G, B] = [r / 255, g / 255, b / 255];
	const max = Math.max(R, G, B);
	const min = Math.min(R, G, B);
	const l = (max + min) / 2;
	if (max === min) return { h: 0, l, s: 0 };
	const d = max - min;
	const s = l <= 0.5 ? d / (max + min) : d / (2 - max - min);
	const h6 = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
	return { h: h6 * 60, l, s };
}

test("black field with red: red, not pink", () => {
	const [r, g, b] = pickAccent(field([5, 3, 4], { patch: [200, 20, 25], share: 0.15 }));
	const { h, l, s } = hls(r, g, b);
	expect(h < 15 || h > 345).toBe(true);
	expect(l).toBeGreaterThanOrEqual(0.58);
	expect(s).toBeGreaterThanOrEqual(0.45);
});

test("near-white is neutral", () => {
	const { l } = hls(...pickAccent(solid([246, 244, 240])));
	expect(l).toBeCloseTo(0.78, 2);
});

test("greyscale gradient is neutral", () => {
	const { l } = hls(...pickAccent(greyRamp()));
	expect(l).toBeCloseTo(0.78, 2);
});

test("greyscale gradient comes out grey, not tinted", () => {
	const [r, g, b] = pickAccent(greyRamp());
	expect(r).toBe(g);
	expect(g).toBe(b);
});

test("neutral covers keep their warm or cool lean", () => {
	const [wr, , wb] = pickAccent(solid([246, 244, 240]));
	expect(wr).toBeGreaterThan(wb);
	const [cr, , cb] = pickAccent(solid([236, 240, 247]));
	expect(cb).toBeGreaterThan(cr);
});

test("an all-dark cover has no lit pixels and falls to a plain light grey", () => {
	expect(pickAccent(solid([10, 10, 10]))).toEqual([199, 199, 199]);
});

test("small vivid accent on dark wins", () => {
	const { h } = hls(...pickAccent(field([20, 22, 30], { patch: [30, 200, 90], share: 0.02 })));
	expect(h).toBeGreaterThan(130);
	expect(h).toBeLessThan(160);
});

test("hue on a bin edge is not split", () => {
	// half pixels at 9.5 degrees, half at 10.5: one colour near 10
	const { h } = hls(...pickAccent(twoHue(9.5, 10.5)));
	expect(Math.abs(h - 10)).toBeLessThan(3);
});

test("a red straddling 0/360 averages to red, not cyan", () => {
	const { h } = hls(...pickAccent(twoHue(355, 5)));
	expect(h < 10 || h > 350).toBe(true);
});

test("fallback for empty image", () => {
	expect(pickAccent({ width: 0, height: 0, data: new Uint8Array() })).toEqual([235, 235, 235]);
	expect(FALLBACK_ACCENT).toEqual([235, 235, 235]);
});

test("floors apply on the picked path: dull colour is lifted", () => {
	// vivid enough to pass the chroma and value gates, but dark and muddy
	const { l, s } = hls(...pickAccent(solid([60, 10, 10])));
	expect(l).toBeGreaterThanOrEqual(0.58 - 0.005);
	expect(s).toBeGreaterThanOrEqual(0.45 - 0.01);
});

test("lightness is capped at 0.82 on the picked path", () => {
	const { l } = hls(...pickAccent(solid([255, 200, 200])));
	expect(l).toBeLessThanOrEqual(0.82 + 0.005);
	expect(l).toBeGreaterThan(0.8);
});

test("the hue with the most chroma mass wins", () => {
	// two thirds blue, one third green: blue wins
	const img = make(96, 96, (x) => (x < 64 ? [20, 40, 220] : [20, 220, 40]));
	const { h } = hls(...pickAccent(img));
	expect(h).toBeGreaterThan(220);
	expect(h).toBeLessThan(250);
});

test("big covers are downscaled first and still pick the same colour", () => {
	const big = make(480, 320, (_x, y) => (y < 48 ? [200, 20, 25] : [5, 3, 4]));
	const { h } = hls(...pickAccent(big));
	expect(h < 15 || h > 345).toBe(true);
});

test("never mutates its input", () => {
	const img = field([5, 3, 4], { patch: [200, 20, 25], share: 0.15 });
	const copy = Uint8Array.from(img.data);
	pickAccent(img);
	expect(Array.from(img.data)).toEqual(Array.from(copy));
});

test("always returns three integers in 0-255", () => {
	const covers: Rgb[] = [
		[0, 0, 0],
		[255, 255, 255],
		[255, 0, 0],
		[0, 255, 255],
		[128, 64, 200]
	];
	for (const rgb of covers) {
		for (const c of pickAccent(solid(rgb))) {
			expect(Number.isInteger(c)).toBe(true);
			expect(c).toBeGreaterThanOrEqual(0);
			expect(c).toBeLessThanOrEqual(255);
		}
	}
});

test("pyRound rounds half to even, like Python's round()", () => {
	expect([0.5, 1.5, 2.5, 3.5, 4.5].map(pyRound)).toEqual([0, 2, 2, 4, 4]);
	expect([0.49, 0.51, 254.5, 127.5, 126.5].map(pyRound)).toEqual([0, 1, 254, 128, 126]);
});
