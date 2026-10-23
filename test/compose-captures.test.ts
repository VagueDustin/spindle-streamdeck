import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { composeMarketplace, parseManifest, sampleSequence, shownAt, shownAtTime, svgFromUri, type CaptureFrame } from "../scripts/compose-captures";

const f = (n: number, t: number, keys: { fg?: string; bg?: string }): CaptureFrame => ({ n, dial: 0, t, ...keys });

// One dial's captures, sorted by n: the bg is only sent when it changes.
const FRAMES: CaptureFrame[] = [
	f(10, 1000, { fg: "fg10", bg: "bgA" }),
	f(11, 1100, { fg: "fg11" }),
	f(12, 1200, { fg: "fg12", bg: "bgB" }),
	f(13, 1300, { bg: "bgC" }),
	f(15, 1500, { fg: "fg15" })
];

describe("shownAt", () => {
	it("takes the frame's own fg and bg when it has both", () => {
		expect(shownAt(FRAMES, 12)).toEqual({ fg: "fg12", bg: "bgB" });
	});

	it("takes the latest bg sent at or before the frame", () => {
		expect(shownAt(FRAMES, 11)).toEqual({ fg: "fg11", bg: "bgA" });
		expect(shownAt(FRAMES, 15)).toEqual({ fg: "fg15", bg: "bgC" });
	});

	it("keeps the previous fg for a bg-only frame, as the device does", () => {
		expect(shownAt(FRAMES, 13)).toEqual({ fg: "fg12", bg: "bgC" });
	});

	it("throws when the frame is not in the captures", () => {
		expect(() => shownAt(FRAMES, 14)).toThrow(/14/);
	});

	it("throws when no bg was captured at or before the frame (pruned from the ring)", () => {
		expect(() => shownAt([f(20, 0, { fg: "x" })], 20)).toThrow(/no bg/);
	});
});

describe("sampleSequence", () => {
	it("samples what the dial showed every 1000/fps ms from the first frame to the last", () => {
		expect(sampleSequence(FRAMES, 11, 15, 10)).toEqual([
			{ fg: "fg11", bg: "bgA" }, // 1100
			{ fg: "fg12", bg: "bgB" }, // 1200
			{ fg: "fg12", bg: "bgC" }, // 1300
			{ fg: "fg12", bg: "bgC" }, // 1400: nothing new was sent
			{ fg: "fg15", bg: "bgC" } // 1500
		]);
	});

	it("follows the fps", () => {
		expect(sampleSequence(FRAMES, 10, 15, 5)).toEqual([
			{ fg: "fg10", bg: "bgA" }, // 1000
			{ fg: "fg12", bg: "bgB" }, // 1200
			{ fg: "fg12", bg: "bgC" } // 1400
		]);
	});

	it("rejects a range that runs backwards", () => {
		expect(() => sampleSequence(FRAMES, 15, 11, 10)).toThrow(/before/);
	});
});

describe("svgFromUri", () => {
	it("decodes the controller's percent-encoded SVG data URI", () => {
		const svg = '<svg width="200"><text>A & <B> 灯</text></svg>';
		expect(svgFromUri(`data:image/svg+xml,${encodeURIComponent(svg)}`)).toBe(svg);
	});

	it("rejects anything else", () => {
		expect(() => svgFromUri("data:image/png;base64,AAAA")).toThrow(/SVG/);
	});
});

describe("parseManifest", () => {
	it("splits stills from the GIF and defaults the GIF to 10 fps", () => {
		const m = parseManifest({
			rest: { frame: "capture/000123-0.json" },
			"no-art": { frame: "capture/000140-1.json" },
			gif: { from: "capture/000200-0.json", to: "capture/000260-0.json" }
		});
		expect(m).toEqual({
			stills: { rest: "capture/000123-0.json", "no-art": "capture/000140-1.json" },
			gif: { from: "capture/000200-0.json", to: "capture/000260-0.json", fps: 10 }
		});
	});

	it("rejects unknown keys, unsafe names and bad values", () => {
		expect(() => parseManifest([])).toThrow();
		expect(() => parseManifest({ rest: { frame: "a.json", extra: 1 } })).toThrow(/extra/);
		expect(() => parseManifest({ "../evil": { frame: "a.json" } })).toThrow(/name/);
		expect(() => parseManifest({ rest: { frame: 5 } })).toThrow(/frame/);
		expect(() => parseManifest({ gif: { from: "a.json", to: "b.json", fps: 0 } })).toThrow(/fps/);
		expect(() => parseManifest({ gif: { from: "a.json" } })).toThrow(/to/);
	});
});

describe("parseManifest marketplace outputs", () => {
	it("collects stills that ask for a marketplace image, with their caption", () => {
		const m = parseManifest({
			hero: { frame: "capture/000001-0.json", marketplace: "Now Playing" },
			takeover: { frame: "capture/000002-0.json", marketplace: true },
			rest: { frame: "capture/000003-0.json" }
		});
		expect(m.stills).toEqual({
			hero: "capture/000001-0.json",
			takeover: "capture/000002-0.json",
			rest: "capture/000003-0.json"
		});
		expect(m.marketplace).toEqual({ hero: "Now Playing", takeover: "" });
	});

	it("leaves marketplace out when no still asks for it", () => {
		expect(parseManifest({ rest: { frame: "a-0.json" } })).not.toHaveProperty("marketplace");
	});

	it("rejects a marketplace value that is not true or a caption", () => {
		expect(() => parseManifest({ rest: { frame: "a.json", marketplace: false } })).toThrow(/marketplace/);
		expect(() => parseManifest({ rest: { frame: "a.json", marketplace: "" } })).toThrow(/marketplace/);
		expect(() => parseManifest({ rest: { frame: "a.json", marketplace: 3 } })).toThrow(/marketplace/);
		expect(() => parseManifest({ rest: { frame: "a.json", marketplace: "x".repeat(41) } })).toThrow(/marketplace/);
	});
});

describe("composeMarketplace", () => {
	const solid = (r: number, g: number, b: number): string => {
		const png = new PNG({ width: 8, height: 4 });
		for (let i = 0; i < png.data.length; i += 4) png.data.set([r, g, b, 255], i);
		return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
	};
	const strip = { width: 900, height: 450, data: new Uint8Array(900 * 450 * 4).map((_, i) => (i % 4 === 3 ? 255 : i % 4 === 0 ? 200 : 20)) };

	it("makes a 1920x960 image with the strip untouched in the middle and a dark backdrop around it", () => {
		const img = composeMarketplace(solid(180, 60, 60), strip, "");
		expect([img.width, img.height]).toEqual([1920, 960]);
		const at = (x: number, y: number) => Array.from(img.data.slice((y * 1920 + x) * 4, (y * 1920 + x) * 4 + 4));
		expect(at(960, 480)).toEqual([200, 20, 20, 255]);
		const [r, g, b] = at(40, 40);
		expect(Math.max(r, g, b)).toBeLessThan(120);
		expect(r).toBeGreaterThan(g);
	});

	it("draws a caption below the strip when given one, and escapes it", () => {
		const plain = composeMarketplace(solid(40, 40, 40), strip, "");
		const captioned = composeMarketplace(solid(40, 40, 40), strip, "A & <B>");
		const row = (img: typeof plain, y: number) => img.data.slice(y * 1920 * 4, (y + 1) * 1920 * 4);
		const lit = (img: typeof plain) => {
			let n = 0;
			for (let y = 700; y < 900; y++) for (const v of row(img, y).filter((_, i) => i % 4 === 0)) if (v > 200) n++;
			return n;
		};
		expect(lit(plain)).toBe(0);
		expect(lit(captioned)).toBeGreaterThan(50);
	});
});

describe("Wide and key outputs", () => {
	it("parses wide stills, the wide GIF and the keys row", () => {
		const m = parseManifest({
			wide: { frame: "c/000001-0.json" },
			"wide-takeover": { frame: "c/000002-0.json" },
			"wide-gif": { from: "c/000003-0.json", to: "c/000009-0.json", fps: 5 },
			keys: { frames: ["c/000010-100.json", "c/000011-101.json"] }
		});
		expect(m.wide).toEqual({ wide: "c/000001-0.json", "wide-takeover": "c/000002-0.json" });
		expect(m.wideGif).toEqual({ from: "c/000003-0.json", to: "c/000009-0.json", fps: 5 });
		expect(m.keys).toEqual({ keys: ["c/000010-100.json", "c/000011-101.json"] });
		expect(m.stills).toEqual({});
	});

	it("rejects malformed entries", () => {
		expect(() => parseManifest({ wide: { frame: "a.json", marketplace: true } })).toThrow(/marketplace/);
		expect(() => parseManifest({ keys: { frames: [] } })).toThrow(/keys/);
		expect(parseManifest({ "transport-keys": { frames: ["c/000012-111.json"] } }).keys).toEqual({ "transport-keys": ["c/000012-111.json"] });
		expect(() => parseManifest({ "wide-gif": { from: "a.json", to: "b.json", fps: 99 } })).toThrow(/fps/);
	});

	it("finds what the other half showed at the same moment", () => {
		const right: CaptureFrame[] = [
			{ n: 1, dial: 1, t: 100, fg: "f1", bg: "b1" },
			{ n: 3, dial: 1, t: 300, fg: "f3" }
		];
		expect(shownAtTime(right, 250)).toEqual({ fg: "f1", bg: "b1" });
		expect(shownAtTime(right, 300)).toEqual({ fg: "f3", bg: "b1" });
		expect(() => shownAtTime(right, 50)).toThrow(/nothing was sent/);
	});
});
