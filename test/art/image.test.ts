// test/fixtures/progressive.jpg was generated once with Pillow 12.3 (progressive JPEG, 64x64 gradient):
//   python -c "from PIL import Image; im=Image.new('RGB',(64,64)); im.putdata([(x*4,y*4,128) for y in range(64) for x in range(64)]); im.save('test/fixtures/progressive.jpg', progressive=True, quality=85)"
import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** One PNG chunk: length, type, data, CRC. */
const chunk = (type: string, data: Uint8Array = new Uint8Array()) => {
	const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE(crc32(body), 8 + data.length);
	return out;
};

/** IHDR payload for an 8-bit RGB image. */
const ihdrData = (width: number, height: number, interlaced = false) => {
	const d = Buffer.alloc(13);
	d.writeUInt32BE(width, 0);
	d.writeUInt32BE(height, 4);
	d[8] = 8;
	d[9] = 2;
	d[12] = interlaced ? 1 : 0;
	return d;
};

const png = (...chunks: Buffer[]) => Uint8Array.from(Buffer.concat([PNG_SIGNATURE, ...chunks]));

/** A valid PNG with extra chunks spliced in just before its IEND. */
const withBeforeIend = (valid: Uint8Array, ...extra: Buffer[]) =>
	Uint8Array.from(Buffer.concat([valid.subarray(0, valid.length - 12), ...extra, valid.subarray(valid.length - 12)]));

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

	test("the PNG pixel cap is 16 MP: a 20 MP header is refused before allocating", () => {
		const bytes = encodePng(solid([1, 2, 3], 4));
		const dv = new DataView(bytes.buffer, bytes.byteOffset);
		dv.setUint32(16, 5000);
		dv.setUint32(20, 4000);
		expect(() => decodeImage(bytes)).toThrow(/exceeds 16 megapixels/);
		// Exactly 16 MP passes the cap (it then fails on the 4x4 body, not on the size).
		dv.setUint32(16, 4000);
		dv.setUint32(20, 4000);
		expect(() => decodeImage(bytes)).toThrow(/PNG/);
		expect(() => decodeImage(bytes)).not.toThrow(/megapixels/);
	});

	test("an interlaced PNG is refused before inflating (decompression bomb)", () => {
		// A 1x1 interlaced PNG whose IDAT inflates to 50 MB: pngjs inflates interlaced data unbounded.
		const bomb = Uint8Array.from(
			Buffer.concat([
				Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
				chunk("IHDR", ihdrData(1, 1, true)),
				chunk("IDAT", deflateSync(Buffer.alloc(50_000_000))),
				chunk("IEND", new Uint8Array())
			])
		);
		expect(bomb[28]).toBe(1);
		const t0 = performance.now();
		expect(() => decodeImage(bomb)).toThrow(UnsupportedImageError);
		expect(() => decodeImage(bomb)).toThrow(/interlaced PNG/);
		expect(performance.now() - t0).toBeLessThan(50);
	});

	describe("PNG chunk structure (N1: pngjs honours a later IHDR, so only one may exist)", () => {
		const valid = () => encodePng(solid([1, 2, 3], 4));
		const refusedFast = (bytes: Uint8Array, pattern: RegExp) => {
			const t0 = performance.now();
			expect(() => decodeImage(bytes)).toThrow(UnsupportedImageError);
			expect(() => decodeImage(bytes)).toThrow(pattern);
			expect(performance.now() - t0).toBeLessThan(100);
		};

		test("a valid PNG followed by a second IHDR declaring 30000x30000 is refused fast", () => {
			refusedFast(withBeforeIend(valid(), chunk("IHDR", ihdrData(30000, 30000))), /more than one IHDR/);
		});

		test("a valid PNG followed by a second, interlaced IHDR is refused fast", () => {
			refusedFast(withBeforeIend(valid(), chunk("IHDR", ihdrData(1, 1, true))), /more than one IHDR/);
		});

		test("a benign first IHDR cannot hide a bomb behind a second interlaced IHDR", () => {
			const bomb = png(
				chunk("IHDR", ihdrData(1, 1)),
				chunk("IDAT", deflateSync(Buffer.alloc(50_000_000))),
				chunk("IHDR", ihdrData(1, 1, true)),
				chunk("IEND")
			);
			refusedFast(bomb, /more than one IHDR/);
		});

		test("a file whose first chunk is not IHDR is refused", () => {
			refusedFast(png(chunk("IDAT", deflateSync(Buffer.alloc(16))), chunk("IHDR", ihdrData(1, 1)), chunk("IEND")), /first chunk/);
			refusedFast(png(chunk("tEXt", Buffer.from("a\0b")), chunk("IHDR", ihdrData(1, 1)), chunk("IEND")), /first chunk/);
		});

		test("a truncated chunk length is refused", () => {
			const head = Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdrData(1, 1))]);
			refusedFast(Uint8Array.from(Buffer.concat([head, Buffer.from([0, 0])])), /truncated/);
		});

		test("a chunk that claims more data than the file holds is refused", () => {
			const lie = Buffer.alloc(8);
			lie.writeUInt32BE(0xffff_fff0, 0);
			lie.write("IDAT", 4, "latin1");
			refusedFast(Uint8Array.from(Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdrData(1, 1)), lie])), /truncated/);
		});

		test("a PNG cut off before IEND is refused", () => {
			const v = valid();
			refusedFast(v.subarray(0, v.length - 12), /truncated/);
		});

		test("a chunk-spam file is refused by the chunk cap without a slow walk", () => {
			const spam = Array.from({ length: 10_001 }, () => chunk("teXt"));
			refusedFast(png(chunk("IHDR", ihdrData(1, 1)), ...spam, chunk("IEND")), /too many chunks/);
		});

		test("ordinary ancillary chunks around the image data still decode", () => {
			const src = make(3, 2, (x, y) => [x * 50, y * 80, 7]);
			const out = decodeImage(withBeforeIend(encodePng(src), chunk("teXt", Buffer.from("k\0v")), chunk("pHYs", Buffer.alloc(9))));
			expect(Array.from(out.data)).toEqual(Array.from(src.data));
		});
	});

	test("a JPEG with more than 100 SOS markers is refused before decoding (scan bomb)", () => {
		const base = encodeJpeg(gradient(16, 16));
		const eoi = base.length - 2;
		// Minimal one-component scan header; the count runs before jpeg-js ever sees it.
		const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];
		const withScans = (extra: number) =>
			Uint8Array.from([...base.subarray(0, eoi), ...Array.from({ length: extra }, () => sos).flat(), 0xff, 0xd9]);
		const many = withScans(100); // 101 SOS markers in all
		const t0 = performance.now();
		expect(() => decodeImage(many)).toThrow(UnsupportedImageError);
		expect(performance.now() - t0).toBeLessThan(50);
		// At the cap (100 in all) the count passes; whatever jpeg-js then makes of it is not a scan-count refusal.
		let atCap: unknown;
		try {
			decodeImage(withScans(99));
		} catch (e) {
			atCap = e;
		}
		expect(atCap).not.toBeInstanceOf(UnsupportedImageError);
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
