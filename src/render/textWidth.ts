import { FALLBACK_EM, WIDTHS } from "./widths.generated";

export type FontSpec = { size: number; weight: 400 | 500 | 600 | 700 };

/** Advance widths ignore kerning and hinting, so the estimate is padded to err on the long side. */
const SAFETY_FACTOR = 1.06;

/** Code point ranges rendered at 1 em: Hangul Jamo, CJK (incl. kana U+3040-U+30FF), Hangul syllables, compatibility ideographs, fullwidth forms, emoji. */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x1100, 0x11ff],
	[0x2e80, 0x9fff],
	[0xac00, 0xd7af],
	[0xf900, 0xfaff],
	[0xff01, 0xff60],
	[0x1f300, 0x1faff]
];

/**
 * Zero advance: combining marks (U+0300-U+036F) and the zero-width characters ZWSP, ZWNJ, ZWJ
 * (U+200B-U+200D) and VS16 (U+FE0F). An emoji sequence is therefore counted by its base emoji.
 */
function isZeroWidth(cp: number): boolean {
	return (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200d) || cp === 0xfe0f;
}

function isWide(cp: number): boolean {
	return WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** Total advance of `text` in em, with weight 500 resolved as the mean of 400 and 600. */
function emWidth(text: string, weight: 400 | 600 | 700): number {
	const table = WIDTHS[weight];
	let total = 0;
	for (const ch of text) {
		const cp = ch.codePointAt(0)!;
		if (isZeroWidth(cp)) continue;
		if (isWide(cp)) total += 1;
		else total += table[cp] ?? FALLBACK_EM[weight];
	}
	return total;
}

/** Estimated rendered width in px, already including the +6% safety factor. */
export function estimateWidth(text: string, font: FontSpec): number {
	const em = font.weight === 500 ? (emWidth(text, 400) + emWidth(text, 600)) / 2 : emWidth(text, font.weight);
	return em * font.size * SAFETY_FACTOR;
}
