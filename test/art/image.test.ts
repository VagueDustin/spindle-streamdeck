// test/fixtures/progressive.jpg was generated once with Pillow 12.3 (progressive JPEG, 64x64 gradient):
//   python -c "from PIL import Image; im=Image.new('RGB',(64,64)); im.putdata([(x*4,y*4,128) for y in range(64) for x in range(64)]); im.save('test/fixtures/progressive.jpg', progressive=True, quality=85)"
import { readFileSync } from "node:fs";
import {
	UnsupportedImageError,
	boxBlur,
	coverFit,
	decodeImage,
	encodePng,
	resizeArea,
	saturate,
	type Rgba
} from "../../src/art/image";
import { encodeJpeg, gradient, make, solid } from "../helpers/synth";

type Rgb = [number, number, number];

const px = (img: Rgba, x: number, y: number) => {
	const o = (y * img.width + x) * 4;
	return Array.from(img.data.subarray(o, o + 4));
};
const total = (img: Rgba) => img.data.reduce((a, v, i) => a + (i % 4 === 3 ? 0 : v), 0);

describe("decodeImage", () => {
	test("JPEG round-trips with the right size", () => {
		const out = decodeImage(encodeJpeg(gradient(40, 24), 95));
		expect([out.width, out.height]).toEqual([40, 24]);
		expect(out.data.length).toBe(40 * 24 * 4);
		const [r, g, b, a] = px(out, 20, 12);
		expect(Math.abs(r - 128)).toBeLessThan(12);
		expect(Math.abs(g - 128)).toBeLessThan(12);
		expect(Math.abs(b - 128)).toBeLessThan(12);
		expect(a).toBe(255);
	});

	test("PNG round-trips losslessly", () => {
		const src = make(7, 5, (x, y) => [x * 30, y * 40, 99]);
		const out = decodeImage(encodePng(src));
		expect([out.width, out.height]).toEqual([7, 5]);
		expect(Array.from(out.data)).toEqual(Array.from(src.data));
	});

	test("a 4000x4000 JPEG decodes in under 2 s, or throws: never hangs", { timeout: 60_000 }, () => {
		const bytes = encodeJpeg(gradient(4000, 4000), 60);
		const t0 = performance.now();
		let outcome: Rgba | Error;
		try {
			outcome = decodeImage(bytes);
		} catch (e) {
			outcome = e as Error;
		}
		expect(performance.now() - t0).toBeLessThan(2000);
		if (!(outcome instanceof Error)) expect([outcome.width, outcome.height]).toEqual([4000, 4000]);
	});

	test("a large JPEG inside the memory budget decodes quickly", { timeout: 20_000 }, () => {
		// 4000x4000 exceeds jpeg-js's 256 MB cap and throws (covered above); 3000x3000 is the success path.
		const bytes = encodeJpeg(gradient(3000, 3000), 60);
		const t0 = performance.now();
		const out = decodeImage(bytes);
		expect(performance.now() - t0).toBeLessThan(2000);
		expect([out.width, out.height]).toEqual([3000, 3000]);
	});

	test("a JPEG over the pixel budget throws a clear error", () => {
		// 6000x5000 = 30 MP > the 25 MP cap. Only the header has to be real, so patch a small JPEG's SOF dimensions.
		const bytes = encodeJpeg(gradient(16, 16));
		const sof = bytes.findIndex((v, i) => v === 0xff && bytes[i + 1] === 0xc0);
		const dv = new DataView(bytes.buffer, bytes.byteOffset);
		dv.setUint16(sof + 5, 5000);
		dv.setUint16(sof + 7, 6000);
		expect(() => decodeImage(bytes)).toThrow(/JPEG/);
	});

	test("a progressive JPEG decodes", () => {
		const bytes = new Uint8Array(readFileSync(new URL("../fixtures/progressive.jpg", import.meta.url)));
		expect(bytes.some((v, i) => v === 0xff && bytes[i + 1] === 0xc2)).toBe(true); // SOF2 = progressive
		const out = decodeImage(bytes);
		expect([out.width, out.height]).toEqual([64, 64]);
		const [r0, g0, b0] = px(out, 1, 1);
		const [r1, g1, b1] = px(out, 62, 62);
		expect(r0).toBeLessThan(25);
		expect(g0).toBeLessThan(25);
		expect(r1).toBeGreaterThan(225);
		expect(g1).toBeGreaterThan(225);
		expect(Math.abs(b0 - 128)).toBeLessThan(15);
		expect(Math.abs(b1 - 128)).toBeLessThan(15);
	});

	test("a 1x1 PNG decodes and coverFit to 200x100 does not throw", () => {
		const one = decodeImage(encodePng(make(1, 1, () => [10, 200, 30])));
		expect([one.width, one.height]).toEqual([1, 1]);
		const fit = coverFit(one, 200, 100);
		expect([fit.width, fit.height]).toEqual([200, 100]);
		expect(px(fit, 100, 50)).toEqual([10, 200, 30, 255]);
	});

	test("a PNG with alpha is composited onto black", () => {
		const out = decodeImage(encodePng(make(2, 1, (x) => (x === 0 ? [200, 100, 50, 128] : [200, 100, 50, 0]))));
		const [r, g, b, a] = px(out, 0, 0);
		expect(Math.abs(r - 100)).toBeLessThanOrEqual(1);
		expect(Math.abs(g - 50)).toBeLessThanOrEqual(1);
		expect(Math.abs(b - 25)).toBeLessThanOrEqual(1);
		expect(a).toBe(255);
		expect(px(out, 1, 0)).toEqual([0, 0, 0, 255]);
	});

	test("a PNG whose header claims a huge size throws before allocating", () => {
		const bytes = encodePng(solid([1, 2, 3], 4));
		const dv = new DataView(bytes.buffer, bytes.byteOffset);
		dv.setUint32(16, 30000);
		dv.setUint32(20, 30000);
		expect(() => decodeImage(bytes)).toThrow(/PNG/);
	});

	test("WebP bytes throw UnsupportedImageError", () => {
		const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
		const webp = Uint8Array.from([...ascii("RIFF"), 0x24, 0, 0, 0, ...ascii("WEBPVP8 ")]);
		expect(() => decodeImage(webp)).toThrow(UnsupportedImageError);
	});

	test("empty and garbage input throw UnsupportedImageError", () => {
		expect(() => decodeImage(new Uint8Array())).toThrow(UnsupportedImageError);
		expect(() => decodeImage(Uint8Array.from([1, 2, 3, 4, 5, 6]))).toThrow(UnsupportedImageError);
	});

	test("a truncated JPEG and a truncated PNG throw a clear Error", () => {
		const jpg = encodeJpeg(gradient(64, 64));
		expect(() => decodeImage(jpg.subarray(0, 60))).toThrow(/JPEG/);
		const png = encodePng(gradient(32, 32));
		expect(() => decodeImage(png.subarray(0, 40))).toThrow(/PNG/);
	});
});

describe("resizeArea", () => {
	test("a 2x2 checker down to 1x1 is mid-grey", () => {
		const checker = make(2, 2, (x, y) => ((x + y) % 2 === 0 ? [255, 255, 255] : [0, 0, 0]));
		const [r, g, b, a] = px(resizeArea(checker, 1, 1), 0, 0);
		for (const c of [r, g, b]) expect(Math.abs(c - 127.5)).toBeLessThanOrEqual(1);
		expect(a).toBe(255);
	});

	test("downscale averages whole blocks exactly", () => {
		const src = make(4, 4, (x) => (x < 2 ? [100, 0, 0] : [200, 0, 0]));
		const out = resizeArea(src, 2, 2);
		expect(px(out, 0, 0)).toEqual([100, 0, 0, 255]);
		expect(px(out, 1, 1)).toEqual([200, 0, 0, 255]);
	});

	test("non-integer ratios keep overall brightness", () => {
		const src = gradient(100, 70);
		const out = resizeArea(src, 33, 21);
		expect([out.width, out.height]).toEqual([33, 21]);
		const mean = (i: Rgba) => total(i) / (i.width * i.height * 3);
		expect(Math.abs(mean(out) - mean(src))).toBeLessThan(1);
	});

	test("upscaling is bilinear and stays within the source range", () => {
		const src = make(2, 1, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255]));
		const out = resizeArea(src, 8, 1);
		const row = Array.from({ length: 8 }, (_, x) => px(out, x, 0)[0]);
		expect(row[0]).toBe(0);
		expect(row[7]).toBe(255);
		expect(row).toEqual([...row].sort((a, b) => a - b));
		expect(row[3]).toBeGreaterThan(row[2]);
	});

	test("does not mutate its input and returns a new object", () => {
		const src = gradient(10, 10);
		const copy = Uint8Array.from(src.data);
		const out = resizeArea(src, 5, 5);
		expect(out).not.toBe(src);
		expect(Array.from(src.data)).toEqual(Array.from(copy));
	});

	test("rejects non-positive or fractional targets", () => {
		expect(() => resizeArea(solid([1, 2, 3], 4), 0, 4)).toThrow(RangeError);
		expect(() => resizeArea(solid([1, 2, 3], 4), 2.5, 4)).toThrow(RangeError);
	});
});

describe("coverFit", () => {
	const palette: Rgb[] = [
		[255, 0, 0],
		[0, 255, 0],
		[0, 0, 255],
		[255, 255, 0]
	];

	test("wide sources are cropped left and right", () => {
		const out = coverFit(make(4, 2, (x) => palette[x]), 2, 2);
		expect(px(out, 0, 0)).toEqual([0, 255, 0, 255]);
		expect(px(out, 1, 0)).toEqual([0, 0, 255, 255]);
	});

	test("tall sources are cropped top and bottom", () => {
		const out = coverFit(make(2, 4, (_x, y) => palette[y]), 2, 2);
		expect(px(out, 0, 0)).toEqual([0, 255, 0, 255]);
		expect(px(out, 0, 1)).toEqual([0, 0, 255, 255]);
	});
});

describe("boxBlur", () => {
	test("a white pixel spreads into its neighbours", () => {
		const src = make(21, 21, (x, y) => (x === 10 && y === 10 ? [255, 255, 255] : [0, 0, 0]));
		const out = boxBlur(src, 1);
		expect(px(out, 10, 10)[0]).toBeLessThan(255);
		expect(px(out, 12, 12)[0]).toBeGreaterThan(0);
		expect(px(out, 0, 0)[0]).toBe(0);
		expect(px(out, 9, 11)[0]).toBeGreaterThan(0);
	});

	test("total brightness is preserved within 1%", () => {
		// A single 8-bit pixel cannot do this: its spread (255/9 per cell and so on) is rounded to whole
		// levels on output, which alone costs 1-2%. A small white block keeps that rounding error negligible.
		const src = make(41, 41, (x, y) => (x >= 18 && x < 22 && y >= 18 && y < 22 ? [255, 255, 255] : [0, 0, 0]));
		const out = boxBlur(src, 2);
		expect(px(out, 20, 20)[0]).toBeLessThan(255);
		expect(px(out, 24, 24)[0]).toBeGreaterThan(0);
		expect(Math.abs(total(out) - total(src)) / total(src)).toBeLessThan(0.01);
	});

	test("a flat image stays flat for any radius and pass count", () => {
		const out = boxBlur(solid([50, 100, 150], 9), 3, 2);
		expect(px(out, 0, 0)).toEqual([50, 100, 150, 255]);
		expect(px(out, 4, 4)).toEqual([50, 100, 150, 255]);
	});

	test("radius 0 is the identity, and the input is never mutated", () => {
		const src = gradient(8, 8);
		const copy = Uint8Array.from(src.data);
		expect(Array.from(boxBlur(src, 0).data)).toEqual(Array.from(copy));
		boxBlur(src, 2);
		expect(Array.from(src.data)).toEqual(Array.from(copy));
	});
});

describe("saturate", () => {
	test("factor 1 is the identity and 0 is greyscale", () => {
		const src = make(1, 1, () => [200, 100, 50]);
		expect(px(saturate(src, 1), 0, 0)).toEqual([200, 100, 50, 255]);
		const [r, g, b] = px(saturate(src, 0), 0, 0);
		expect(r).toBe(g);
		expect(g).toBe(b);
	});

	test("factor above 1 widens the channel spread and clamps to 0-255", () => {
		const src = make(1, 1, () => [200, 100, 50]);
		const [r, , b] = px(saturate(src, 3), 0, 0);
		expect(r).toBe(255);
		expect(b).toBe(0);
	});

	test("does not mutate its input", () => {
		const src = make(1, 1, () => [200, 100, 50]);
		saturate(src, 2);
		expect(px(src, 0, 0)).toEqual([200, 100, 50, 255]);
	});
});
