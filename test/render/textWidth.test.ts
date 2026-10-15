import { describe, expect, it } from "vitest";
import { estimateWidth } from "../../src/render/textWidth";

/** Measured on hardware for "Spindle Test Ag 0123" at 600/17px with font-family "Segoe UI": docs/spike-results.md item 3 (+/-3 px). */
const MEASURED_SPIKE_PX = 159;

describe("estimateWidth", () => {
	it("counts CJK as 1 em per character, plus the 6% safety factor", () => {
		const w = estimateWidth("夜に駆ける", { size: 17, weight: 600 });
		expect(Math.abs(w - 5 * 17 * 1.06)).toBeLessThanOrEqual(0.5);
	});

	it("counts kana, Hangul, fullwidth forms and emoji as 1 em each", () => {
		for (const text of ["カタカナ", "아이유", "ＡＢＣ", "🔥🎵"]) {
			const n = [...text].length;
			expect(Math.abs(estimateWidth(text, { size: 20, weight: 400 }) - n * 20 * 1.06)).toBeLessThanOrEqual(0.5);
		}
	});

	it("is monotonic for Latin: narrow glyphs are narrower than wide ones", () => {
		const font = { size: 17, weight: 600 } as const;
		expect(estimateWidth("iiii", font)).toBeLessThan(estimateWidth("WWWW", font));
	});

	it("never underestimates the measured hardware width, and runs at most 15% long", () => {
		const w = estimateWidth("Spindle Test Ag 0123", { size: 17, weight: 600 });
		expect(w).toBeGreaterThanOrEqual(MEASURED_SPIKE_PX);
		expect(w).toBeLessThanOrEqual(MEASURED_SPIKE_PX * 1.15);
	});

	it("returns 0 for the empty string", () => {
		expect(estimateWidth("", { size: 17, weight: 600 })).toBe(0);
	});

	it("adds nothing for combining marks and zero-width characters", () => {
		const font = { size: 17, weight: 400 } as const;
		const base = estimateWidth("e", font);
		expect(estimateWidth("e\u0301", font)).toBe(base);
		expect(estimateWidth("e\u200B\u200C\u200D\uFE0F", font)).toBe(base);
	});

	it("scales linearly with size", () => {
		const a = estimateWidth("Hello", { size: 10, weight: 400 });
		const b = estimateWidth("Hello", { size: 20, weight: 400 });
		expect(b).toBeCloseTo(a * 2, 6);
	});

	it("resolves weight 500 as the mean of 400 and 600", () => {
		const text = "Spindle";
		const mid = estimateWidth(text, { size: 17, weight: 500 });
		const mean = (estimateWidth(text, { size: 17, weight: 400 }) + estimateWidth(text, { size: 17, weight: 600 })) / 2;
		expect(mid).toBeCloseTo(mean, 6);
	});

	it("uses the fallback advance for code points outside the table", () => {
		const w = estimateWidth("\u0410", { size: 17, weight: 400 }); // Cyrillic A: not in the table
		expect(w).toBeGreaterThan(0);
		expect(w).toBeLessThan(17 * 1.06);
	});
});
