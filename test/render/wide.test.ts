import { describe, expect, it } from "vitest";
import { FALLBACK_ACCENT } from "../../src/art/accent";
import type { PlayerState } from "../../src/ha/playerState";
import { estimateWidth } from "../../src/render/textWidth";
import { renderWideBody, type WideUi } from "../../src/render/wide";

const player = (over: Partial<PlayerState> = {}): PlayerState => ({
	entityId: "media_player.den",
	status: "playing",
	friendlyName: "Den",
	title: "Song",
	artist: "Band",
	volume: 40,
	muted: false,
	features: 0,
	...over
});

const ui: WideUi = { volume: 40, muted: false, volumeDisplay: "number", takeoverAlpha: 0, flashDir: 0, offset: 0, buffering: false, dimmed: false };
const body = (p: Partial<PlayerState>) => renderWideBody(player(p), ui, FALLBACK_ACCENT, 0).body;
/** The <text> elements whose content is exactly `s`. */
const textsOf = (svg: string, s: string) => svg.match(new RegExp(`<text [^>]*>${s}</text>`, "g")) ?? [];

describe("renderWide rest view", () => {
	it("centres a title and artist that fit on the seam between the two keys", () => {
		const svg = body({ title: "星灯", artist: "Kawaguchi Yurina" });
		for (const s of ["星灯", "Kawaguchi Yurina"]) {
			const [t] = textsOf(svg, s);
			expect(t).toContain('x="200"');
			expect(t).toContain('text-anchor="middle"');
		}
	});

	it("starts a line too wide to centre beside the thumbnail, and scrolls one wider than the text area", () => {
		const svg = body({ title: "Wide Enough Not To Centre", artist: "An Artist Whose Name Is Far Too Long To Fit In The Space Beside The Art" });
		const [title] = textsOf(svg, "Wide Enough Not To Centre");
		expect(title).toContain('x="80"');
		expect(title).not.toContain("text-anchor");
		expect(svg).toContain('<mask id="wartist"');
		expect(svg).not.toContain('<mask id="wtitle"');
	});

	it("centres the play bars and source label on the seam as one group", () => {
		const svg = renderWideBody(player(), { ...ui, sourceLabel: "Streaming" }, FALLBACK_ACCENT, 0).body;
		const group = 18 + estimateWidth("Streaming", { size: 11, weight: 400 });
		const left = 200 - group / 2;
		const [label] = textsOf(svg, "Streaming");
		expect(Number(label!.match(/ x="([\d.]+)"/)![1])).toBeCloseTo(left + 18, 0);
		expect(svg).toMatch(new RegExp(`<rect x="${Math.round(left * 10) / 10}" y="[\\d.]+" width="3"`));
	});

	it("fades the centred track text out under the takeover instead of stacking it under the track panel", () => {
		const at = (takeoverAlpha: number) => renderWideBody(player({ title: "星灯" }), { ...ui, takeoverAlpha }, FALLBACK_ACCENT, 0).body;
		expect(at(0.25)).toMatch(/<g opacity="0.75"><text [^>]*text-anchor="middle"[^>]*>星灯<\/text>/);
		expect(at(1)).not.toMatch(/<text [^>]*x="200"[^>]*text-anchor="middle"[^>]*>星灯<\/text>/);
	});

	it("keeps the play bars clear of the thumbnail when the source label is too wide to centre", () => {
		const svg = renderWideBody(player(), { ...ui, sourceLabel: "A Very Long Source Name From Some Streaming Service Or Other" }, FALLBACK_ACCENT, 0).body;
		expect(svg).toMatch(/<rect x="80" y="[\d.]+" width="3"/);
	});
});
