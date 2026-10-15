import { describe, expect, it } from "vitest";
import { parseManifest, sampleSequence, shownAt, svgFromUri, type CaptureFrame } from "../scripts/compose-captures";

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
