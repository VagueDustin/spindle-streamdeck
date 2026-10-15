// The `fg` layer (spec 4.2): a transparent 200×100 SVG built per frame by string
// concatenation, with no rasterisation in the plugin (spec 4.3, < 1 ms per frame).
import type { Rgb } from "../art/accent";
import type { PlayerState } from "../ha/playerState";
import { FONT_STACK, STRIP_H, STRIP_W } from "./geometry";
import { estimateWidth, type FontSpec } from "./textWidth";

export type DialUi = {
	mode: "volume" | "tracks";
	volume: number;
	muted: boolean;
	/** VOLUME_SET / VOLUME_STEP only / neither. */
	volumeDisplay: "number" | "bar-only" | "hidden";
	/** 0..1, computed by the controller. */
	takeoverAlpha: number;
	flashDir: -1 | 0 | 1;
	/** Marquee scroll position, px. */
	offset: number;
	sourceLabel?: string;
	/** Replaces title and artist (spec 7). */
	message?: { headline: string; sub?: string };
	dimmed: boolean;
	/** e.g. "Reconnecting…" */
	badge?: string;
	buffering: boolean;
};

/** `animating`: content moves (bars or scrolling text). `halfRate`: the bars are the only motion. */
export type Frame = { svg: string; animating: boolean; halfRate: boolean };

// Every y below is a text line's vertical centre, as in the predecessor (canvas
// textBaseline "middle"). The deck's SVG renderer has no dominant-baseline, so the
// baseline is placed BASELINE em below the centre, which centres cap height on the line.
const BASELINE = 0.35;
const TEXT_X = 74;
const TEXT_W = 120;
const TITLE_Y = 20;
const ARTIST_Y = 40;
const TITLE_FONT: FontSpec = { size: 17, weight: 600 };
const ARTIST_FONT: FontSpec = { size: 13, weight: 400 };
const MARQUEE_GAP = 28;
const BARS_X = 74;
const BARS_BASE = 64;
const SOURCE = { x: 92, y: 58, w: 102, font: { size: 11, weight: 500 } as FontSpec };
const ROW_Y = 83;
const TRACK = { x: 8, y: ROW_Y - 3, w: 150, h: 6 };
const VOLUME_X = 194;
const MUTE_RED = 'fill="rgb(255,110,110)"';
const TAKEOVER = { scrim: 0.62, barX: 12, barY: 80, barW: STRIP_W - 24, barH: 8, knobR: 6 };
const CHEVRON = { size: 16, back: 60, forward: 140 };

const WHITE = 'fill="#fff"';
const white = (alpha: number) => `fill="#fff" fill-opacity="${alpha}"`;
const css = (c: Rgb) => `rgb(${c[0]},${c[1]},${c[2]})`;
/** One decimal place keeps the SVG short and the numbers stable. */
const n = (v: number) => String(Math.round(v * 10) / 10);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

const SVG_OPEN = `<svg xmlns="http://www.w3.org/2000/svg" width="${STRIP_W}" height="${STRIP_H}" viewBox="0 0 ${STRIP_W} ${STRIP_H}">`;
const fullRect = (attrs: string) => `<rect x="0" y="0" width="${STRIP_W}" height="${STRIP_H}" ${attrs}/>`;

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
/**
 * The five XML specials, plus everything XML 1.0 forbids: C0 controls other than tab,
 * LF and CR; U+FFFE and U+FFFF; and unpaired surrogates. Paired surrogates (emoji) pass.
 */
const UNSAFE = /[&<>"'\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Text safe for an SVG text node or attribute value: escaped, and stripped of characters invalid in XML 1.0. */
export function escapeXml(s: string): string {
	return s.replace(UNSAFE, (ch) => ENTITIES[ch] ?? "");
}

/** `body` must already be escaped. `y` is the line's vertical centre. */
function text(x: number, y: number, font: FontSpec, paint: string, body: string, extra = ""): string {
	return `<text x="${n(x)}" y="${n(y + font.size * BASELINE)}" font-family="${FONT_STACK}" font-size="${font.size}" font-weight="${font.weight}" ${paint}${extra}>${body}</text>`;
}

type Box = { id: string; x: number; w: number };
type Drawn = { svg: string; scrolls: boolean };

/**
 * Text in a box: drawn plainly when the estimate fits, otherwise two copies 28 px apart
 * scroll by `offset` inside a clip the width of the box.
 */
function marquee(box: Box, raw: string, y: number, font: FontSpec, paint: string, offset: number): Drawn {
	const body = escapeXml(raw);
	const w = estimateWidth(raw, font);
	if (w <= box.w) return { svg: text(box.x, y, font, paint, body), scrolls: false };
	const span = w + MARQUEE_GAP;
	const x = box.x - (((offset % span) + span) % span);
	const clip = `<clipPath id="${box.id}"><rect x="${box.x}" y="0" width="${box.w}" height="${STRIP_H}"/></clipPath>`;
	return {
		svg: `${clip}<g clip-path="url(#${box.id})">${text(x, y, font, paint, body)}${text(x + span, y, font, paint, body)}</g>`,
		scrolls: true
	};
}

/** Cuts `raw` to fit `width` (by the estimate), ending in an ellipsis when cut. Returns escaped text. */
function ellipsize(raw: string, width: number, font: FontSpec): string {
	if (estimateWidth(raw, font) <= width) return escapeXml(raw);
	const chars = [...raw];
	while (chars.length > 0 && estimateWidth(`${chars.join("").trimEnd()}…`, font) > width) chars.pop();
	return escapeXml(`${chars.join("").trimEnd()}…`);
}

/** Three accent bars bouncing on the base line; half height while buffering. */
function playBars(t: number, half: boolean, accent: Rgb): string {
	const fill = `fill="${css(accent)}"`;
	let s = "";
	for (let i = 0; i < 3; i++) {
		let h = 3 + Math.abs(Math.sin(t * 0.006 + i * 1.9)) * 9;
		if (half) h /= 2;
		s += `<rect x="${n(BARS_X + i * 5)}" y="${n(BARS_BASE - h)}" width="3" height="${n(h)}" rx="1.5" ${fill}/>`;
	}
	return s;
}

function pauseGlyph(): string {
	const bar = (x: number) => `<rect x="${x}" y="${BARS_BASE - 10}" width="3" height="10" rx="1" ${white(0.7)}/>`;
	return bar(BARS_X + 1) + bar(BARS_X + 7);
}

/** The source label beside the bars, clipped (not scrolled) to the strip's right margin. */
function sourceLabel(label: string): string {
	return marquee({ id: "source", x: SOURCE.x, w: SOURCE.w }, label, SOURCE.y, SOURCE.font, white(0.6), 0).svg;
}

/** Track, fill and the number (or MUTE) right-aligned at x=194. */
function volumeRow(ui: DialUi, accent: Rgb): string {
	if (ui.volumeDisplay === "hidden") return "";
	const frac = clamp(ui.volume, 0, 100) / 100;
	const bar = (w: number, paint: string) => `<rect x="${TRACK.x}" y="${TRACK.y}" width="${n(w)}" height="${TRACK.h}" rx="3" ${paint}/>`;
	let s = bar(TRACK.w, white(0.22));
	if (frac > 0) s += bar(Math.max(TRACK.w * frac, TRACK.h), ui.muted ? white(0.35) : `fill="${css(accent)}"`);
	const end = ' text-anchor="end"';
	if (ui.muted) s += text(VOLUME_X, ROW_Y, { size: 12, weight: 700 }, MUTE_RED, "MUTE", end);
	else if (ui.volumeDisplay === "number") s += text(VOLUME_X, ROW_Y, { size: 20, weight: 700 }, WHITE, String(Math.round(ui.volume)), end);
	return s;
}

/** A double chevron centred on cx, pointing `dir`: two triangles 0.7·size wide, 0.9·size apart. */
function chevronPair(cx: number, dir: -1 | 1, paint: string): string {
	const { size } = CHEVRON;
	const w = size * 0.7;
	const step = size * 0.9;
	const start = cx - (dir * (step + w)) / 2;
	let d = "";
	for (let i = 0; i < 2; i++) {
		const x = start + dir * i * step;
		d += `M${n(x)} ${n(ROW_Y - size / 2)}L${n(x + dir * w)} ${n(ROW_Y)}L${n(x)} ${n(ROW_Y + size / 2)}Z`;
	}
	return `<path d="${d}" ${paint}/>`;
}

/** Tracks mode's row: back and forward chevrons and a centre dot; the firing side flashes in the accent. */
function trackChevrons(flashDir: -1 | 0 | 1, accent: Rgb): string {
	const paint = (dir: -1 | 1) => (flashDir === dir ? `fill="${css(accent)}"` : white(0.6));
	return (
		chevronPair(CHEVRON.back, -1, paint(-1)) +
		chevronPair(CHEVRON.forward, 1, paint(1)) +
		`<circle cx="${STRIP_W / 2}" cy="${ROW_Y}" r="3" ${white(0.4)}/>`
	);
}

/** "Idle", "Off", "Unavailable"... for a player with no title. */
const statusWord = (status: string) => status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " ");

type Rest = { svg: string; bars: boolean; scrolls: boolean };

function restView(p: PlayerState, ui: DialUi, accent: Rgb, t: number): Rest {
	const title = p.title || p.friendlyName;
	const artist = p.title ? (p.artist ?? "") : statusWord(p.status);
	const box = (id: string): Box => ({ id, x: TEXT_X, w: TEXT_W });
	const top = marquee(box("title"), title, TITLE_Y, TITLE_FONT, WHITE, ui.offset);
	const sub = artist ? marquee(box("artist"), artist, ARTIST_Y, ARTIST_FONT, white(0.72), ui.offset) : { svg: "", scrolls: false };
	const bars = p.status === "playing" || p.status === "buffering";
	let svg = top.svg + sub.svg;
	if (bars) svg += playBars(t, ui.buffering || p.status === "buffering", accent);
	else if (p.title) svg += pauseGlyph();
	if (ui.sourceLabel) svg += sourceLabel(ui.sourceLabel);
	svg += ui.mode === "tracks" ? trackChevrons(ui.flashDir, accent) : volumeRow(ui, accent);
	return { svg, bars, scrolls: top.scrolls || sub.scrolls };
}

/** The volume takeover (spec 4.2): scrim, labels, big number and a wide bar with a knob. */
function takeover(p: PlayerState, ui: DialUi, accent: Rgb): string {
	const T = TAKEOVER;
	let s = fullRect(`fill="#000" opacity="${T.scrim}"`);
	s += text(12, 15, { size: 11, weight: 600 }, white(0.6), "VOLUME");
	if (p.title) s += marquee({ id: "takeover", x: 70, w: STRIP_W - 82 }, p.title, 15, { size: 11, weight: 400 }, white(0.5), ui.offset).svg;
	const mid = ' text-anchor="middle"';
	if (ui.muted) s += text(STRIP_W / 2, 50, { size: 30, weight: 700 }, MUTE_RED, "MUTE", mid);
	else if (ui.volumeDisplay === "number") s += text(STRIP_W / 2, 50, { size: 44, weight: 700 }, WHITE, String(Math.round(ui.volume)), mid);
	if (ui.volumeDisplay !== "hidden") {
		const frac = clamp(ui.volume, 0, 100) / 100;
		const bar = (w: number, paint: string) => `<rect x="${T.barX}" y="${T.barY}" width="${n(w)}" height="${T.barH}" rx="4" ${paint}/>`;
		s += bar(T.barW, white(0.18));
		if (frac > 0) s += bar(Math.max(T.barW * frac, T.barH), ui.muted ? white(0.35) : `fill="${css(accent)}"`);
		s += `<circle cx="${n(T.barX + T.barW * frac)}" cy="${T.barY + T.barH / 2}" r="${T.knobR}" ${WHITE}/>`;
	}
	return s;
}

/** Spec 7's messages: the headline in the title slot, the sub-line in the artist slot. Never scrolls. */
function messageView(m: { headline: string; sub?: string }): string {
	let s = text(TEXT_X, TITLE_Y, TITLE_FONT, WHITE, ellipsize(m.headline, TEXT_W, TITLE_FONT));
	if (m.sub) s += text(TEXT_X, ARTIST_Y, ARTIST_FONT, white(0.72), ellipsize(m.sub, TEXT_W, ARTIST_FONT));
	return s;
}

/** A small dark pill near the top-right, e.g. "Reconnecting…". */
function badge(label: string): string {
	const font: FontSpec = { size: 11, weight: 600 };
	const body = ellipsize(label, 150, font);
	const right = STRIP_W - 4;
	const w = Math.min(estimateWidth(label, font), 150) + 12;
	return (
		`<rect x="${n(right - w)}" y="4" width="${n(w)}" height="16" rx="8" fill="#000" fill-opacity="0.7"/>` +
		text(right - 6, 12, font, WHITE, body, ' text-anchor="end"')
	);
}

const opacity = (a: number) => String(Math.round(a * 100) / 100);

export function renderForeground(p: PlayerState | null, ui: DialUi, accent: Rgb, t: number): Frame {
	let body = "";
	let animating = false;
	let halfRate = false;
	if (ui.message) {
		body = messageView(ui.message);
	} else if (p) {
		const rest = restView(p, ui, accent, t);
		// Flags describe content motion only; takeover timing is the controller's.
		animating = rest.bars || rest.scrolls;
		halfRate = rest.bars && !rest.scrolls;
		const alpha = ui.mode === "volume" ? clamp(ui.takeoverAlpha, 0, 1) : 0;
		if (alpha <= 0) body = rest.svg;
		else if (alpha >= 1) body = takeover(p, ui, accent);
		else body = `<g opacity="${opacity(1 - alpha)}">${rest.svg}</g><g opacity="${opacity(alpha)}">${takeover(p, ui, accent)}</g>`;
	}
	if (ui.dimmed) body += fullRect('fill="#000" opacity="0.5"');
	if (ui.badge) body += badge(ui.badge);
	return { svg: `${SVG_OPEN}${body}</svg>`, animating, halfRate };
}

/** RENDER_MODE "single": the backdrop embedded as the first child of the fg SVG. */
export function composeSingle(bgDataUri: string, fgSvg: string): string {
	const at = fgSvg.indexOf(">") + 1;
	const image = `<image href="${escapeXml(bgDataUri)}" x="0" y="0" width="${STRIP_W}" height="${STRIP_H}"/>`;
	return fgSvg.slice(0, at) + image + fgSvg.slice(at);
}
