// Accent colour from cover art. A port of pick_accent(), neutral_tint() and
// accent_rgb() from the predecessor's HA-side nowplaying script (the
// accent-chroma-histogram version), including its constants and comments.
import { resizeArea, type Rgba } from "./image";

export type Rgb = [number, number, number];

// --- accent tuning ----------------------------------------------------------
// Per pixel, not per palette entry. The old picker quantised the cover to 12
// colours and scored them by HLS saturation, which is 1.0 for near-black
// colours (#020001 scores S=1.00): on dark art a speck of black won and was
// then lifted into a neon tint (The Witcher 3's black-and-red cover came out
// hot pink). Quantising also averaged small vivid accents into the dark mass.
//
// Instead: a hue histogram over the cover's pixels, each weighted by chroma
// squared (max-min of RGB, which is 0 for black, white and grey), so vivid
// pixels dominate and muddy ones barely count. The peak hue wins, and the
// colour is the weighted average of the pixels near that hue.
const HUE_BINS = 36; // 10 degrees each
const PICK_MIN_CHROMA = 0.18; // below this a pixel is black/white/grey for picking
const PICK_MIN_VALUE = 0.2; // and anything this dark is too
const PICK_MIN_SHARE = 0.006; // under 0.6% chromatic pixels the cover is neutral
const PICK_SPREAD = 1.5; // bins either side of the peak that form the colour
// Floors, so washed-out art still produces something readable against a dark
// panel rather than near-black text.
const ACCENT_LIGHT_MIN = 0.58;
const ACCENT_LIGHT_MAX = 0.82;
const ACCENT_SAT_MIN = 0.45;
// Lightness for covers with no colour worth naming: a light grey that keeps
// the cover's own warm or cool lean. See neutralTint().
const ACCENT_LIGHT_NEUTRAL = 0.78;
// A pixel counts as lit for neutralTint() at or above this brightness.
const NEUTRAL_LIT_MIN = 0.35;

const THUMB_SIDE = 96;

export const FALLBACK_ACCENT: Rgb = [235, 235, 235];

type Hls = [h: number, l: number, s: number];

// --- Python parity helpers --------------------------------------------------
// The reference runs on Python's colorsys, round() and % operators; these
// match them so results agree with it bit for bit.

/** Python's float %: the result takes the sign of the divisor (JS takes the dividend's). */
function pyMod(a: number, b: number): number {
	const m = a % b;
	return m !== 0 && m < 0 !== b < 0 ? m + b : m;
}

/** Python's round(): halves round to the even neighbour (banker's rounding). */
export function pyRound(v: number): number {
	const f = Math.floor(v);
	const diff = v - f;
	if (diff < 0.5) return f;
	if (diff > 0.5) return f + 1;
	return f % 2 === 0 ? f : f + 1;
}

/** Python 3.12+ sum() of floats: Neumaier compensated summation. */
function pySum(values: ArrayLike<number>): number {
	let sum = 0;
	let comp = 0;
	for (let i = 0; i < values.length; i++) {
		const x = values[i];
		const t = sum + x;
		comp += Math.abs(sum) >= Math.abs(x) ? sum - t + x : x - t + sum;
		sum = t;
	}
	return comp !== 0 && Number.isFinite(comp) ? sum + comp : sum;
}

/** colorsys.rgb_to_hsv */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
	const maxc = Math.max(r, g, b);
	const minc = Math.min(r, g, b);
	const rangec = maxc - minc;
	if (minc === maxc) return [0, 0, maxc];
	const s = rangec / maxc;
	const rc = (maxc - r) / rangec;
	const gc = (maxc - g) / rangec;
	const bc = (maxc - b) / rangec;
	const h = r === maxc ? bc - gc : g === maxc ? 2 + rc - bc : 4 + gc - rc;
	return [pyMod(h / 6, 1), s, maxc];
}

/** colorsys.hsv_to_rgb */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
	if (s === 0) return [v, v, v];
	const i = Math.trunc(h * 6);
	const f = h * 6 - i;
	const p = v * (1 - s);
	const q = v * (1 - s * f);
	const t = v * (1 - s * (1 - f));
	switch (pyMod(i, 6)) {
		case 0:
			return [v, t, p];
		case 1:
			return [q, v, p];
		case 2:
			return [p, v, t];
		case 3:
			return [p, q, v];
		case 4:
			return [t, p, v];
		default:
			return [v, p, q];
	}
}

/** colorsys.rgb_to_hls */
function rgbToHls(r: number, g: number, b: number): Hls {
	const maxc = Math.max(r, g, b);
	const minc = Math.min(r, g, b);
	const sumc = maxc + minc;
	const rangec = maxc - minc;
	const l = sumc / 2;
	if (minc === maxc) return [0, l, 0];
	// Python keeps 2.0-maxc-minc here rather than 2.0-sumc (gh-106498): the float results differ.
	const s = l <= 0.5 ? rangec / sumc : rangec / (2 - maxc - minc);
	const rc = (maxc - r) / rangec;
	const gc = (maxc - g) / rangec;
	const bc = (maxc - b) / rangec;
	const h = r === maxc ? bc - gc : g === maxc ? 2 + rc - bc : 4 + gc - rc;
	return [pyMod(h / 6, 1), l, s];
}

const ONE_THIRD = 1 / 3;
const ONE_SIXTH = 1 / 6;
const TWO_THIRD = 2 / 3;

function hlsChannel(m1: number, m2: number, hue: number): number {
	const h = pyMod(hue, 1);
	if (h < ONE_SIXTH) return m1 + (m2 - m1) * h * 6;
	if (h < 0.5) return m2;
	if (h < TWO_THIRD) return m1 + (m2 - m1) * (TWO_THIRD - h) * 6;
	return m1;
}

/** colorsys.hls_to_rgb */
function hlsToRgb(h: number, l: number, s: number): [number, number, number] {
	if (s === 0) return [l, l, l];
	const m2 = l <= 0.5 ? l * (1 + s) : l + s - l * s;
	const m1 = 2 * l - m2;
	return [hlsChannel(m1, m2, h + ONE_THIRD), hlsChannel(m1, m2, h), hlsChannel(m1, m2, h - ONE_THIRD)];
}

// --- the picker -------------------------------------------------------------

/** Pillow's thumbnail((side, side)): keeps the aspect ratio and never upscales. */
function thumbnailSize(w: number, h: number, side: number): [number, number] {
	if (w <= side && h <= side) return [w, h];
	const scale = Math.min(side / w, side / h);
	return [Math.min(side, Math.max(1, Math.round(w * scale))), Math.min(side, Math.max(1, Math.round(h * scale)))];
}

/** The cover shrunk to fit 96x96, as a flat r,g,b,r,g,b... array of 0-1 floats. */
function pixels(img: Rgba): Float64Array {
	const [w, h] = thumbnailSize(img.width, img.height, THUMB_SIDE);
	const small = w === img.width && h === img.height ? img : resizeArea(img, w, h);
	const out = new Float64Array(w * h * 3);
	for (let i = 0, o = 0; i < w * h * 4; i += 4, o += 3) {
		out[o] = small.data[i] / 255;
		out[o + 1] = small.data[i + 1] / 255;
		out[o + 2] = small.data[i + 2] / 255;
	}
	return out;
}

/** HLS of the cover's dominant vivid colour, or null when it has no colour worth naming. */
function pickColour(px: Float64Array): Hls | null {
	const count = px.length / 3;
	const bins = new Array<number>(HUE_BINS).fill(0);
	const hs: number[] = [];
	const ss: number[] = [];
	const vs: number[] = [];
	const ws: number[] = [];
	for (let i = 0; i < px.length; i += 3) {
		const r = px[i];
		const g = px[i + 1];
		const b = px[i + 2];
		const hi = Math.max(r, g, b);
		const lo = Math.min(r, g, b);
		const chroma = hi - lo;
		if (chroma < PICK_MIN_CHROMA || hi < PICK_MIN_VALUE) continue;
		const [h, s, v] = rgbToHsv(r, g, b);
		const w = chroma * chroma;
		bins[Math.trunc(h * HUE_BINS) % HUE_BINS] += w;
		hs.push(h);
		ss.push(s);
		vs.push(v);
		ws.push(w);
	}
	if (hs.length < Math.max(12, count * PICK_MIN_SHARE)) return null;

	// Light smoothing so a hue sitting on a bin edge is not split in two.
	const smooth = bins.map(
		(bin, i) => bins[(i + HUE_BINS - 1) % HUE_BINS] * 0.5 + bin + bins[(i + 1) % HUE_BINS] * 0.5
	);
	let best = 0;
	for (let i = 1; i < HUE_BINS; i++) if (smooth[i] > smooth[best]) best = i;
	const peak = (best + 0.5) / HUE_BINS;

	// Circular mean of the hues near the peak, so a red that straddles 0/360
	// averages to red rather than to cyan.
	let sx = 0;
	let sy = 0;
	let sw = 0;
	let ss_ = 0;
	let sv = 0;
	for (let i = 0; i < hs.length; i++) {
		const d = Math.abs(hs[i] - peak);
		if (Math.min(d, 1 - d) <= PICK_SPREAD / HUE_BINS) {
			sx += ws[i] * Math.cos(2 * Math.PI * hs[i]);
			sy += ws[i] * Math.sin(2 * Math.PI * hs[i]);
			sw += ws[i];
			ss_ += ws[i] * ss[i];
			sv += ws[i] * vs[i];
		}
	}
	const hue = pyMod(Math.atan2(sy, sx) / (2 * Math.PI), 1);
	const [r, g, b] = hsvToRgb(hue, ss_ / sw, sv / sw);
	return rgbToHls(r, g, b);
}

/**
 * HLS of the average of the cover's lit pixels, for art with no colour: keeps
 * whether it leans warm or cool without inventing a hue. (The hue is the
 * average's own, so it deliberately amplifies a cover's warm or cool lean once
 * saturation is applied at the neutral lightness. That is faithful to the
 * reference.)
 */
function neutralTint(px: Float64Array): Hls {
	const rs: number[] = [];
	const gs: number[] = [];
	const bs: number[] = [];
	for (let i = 0; i < px.length; i += 3) {
		if (Math.max(px[i], px[i + 1], px[i + 2]) >= NEUTRAL_LIT_MIN) {
			rs.push(px[i]);
			gs.push(px[i + 1]);
			bs.push(px[i + 2]);
		}
	}
	if (rs.length === 0) return rgbToHls(0.8, 0.8, 0.8);
	const n = rs.length;
	return rgbToHls(pySum(rs) / n, pySum(gs) / n, pySum(bs) / n);
}

/**
 * The accent as 0-255 RGB, floored so it reads against a dark panel. The floors
 * (lightness 0.58-0.82, saturation >= 0.45) apply only to a picked colour;
 * neutral covers use the neutral tint unfloored, so a greyscale cover stays grey.
 */
export function pickAccent(img: Rgba): Rgb {
	if (img.width < 1 || img.height < 1) return [...FALLBACK_ACCENT];
	const px = pixels(img);
	const picked = pickColour(px);
	let hue: number;
	let light: number;
	let sat: number;
	if (picked === null) {
		// No colour worth naming (black/white/grey art): a light grey carrying
		// the cover's own tint, rather than a hue the art does not have.
		[hue, , sat] = neutralTint(px);
		light = ACCENT_LIGHT_NEUTRAL;
	} else {
		[hue, light, sat] = picked;
		light = Math.min(Math.max(light, ACCENT_LIGHT_MIN), ACCENT_LIGHT_MAX);
		sat = Math.max(sat, ACCENT_SAT_MIN);
	}
	const [r, g, b] = hlsToRgb(hue, light, sat);
	return [pyRound(r * 255), pyRound(g * 255), pyRound(b * 255)];
}
