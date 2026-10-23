// The Wide pair's `fg`: one transparent 400×100 SVG per frame, sent to the two strip segments as the
// same drawing with a viewBox offset, so text crossing x = 200 lines up exactly. The left half sits
// above the volume dial and the right half above the skip dial; each half's bottom row belongs to its dial.
import type { Rgb } from "../art/accent";
import type { PlayerState } from "../ha/playerState";
import type { Message } from "../player/session";
import { WIDE_THUMB, WIDE_W } from "./backdrop";
import {
	badge,
	chevronPair,
	css,
	ellipsize,
	escapeXml,
	marquee,
	n,
	pauseGlyph,
	playBars,
	statusWord,
	takeover,
	text,
	volumeRow,
	white,
	WHITE,
	wrap,
	type DialUi,
	type Frame
} from "./foreground";
import { STRIP_H, STRIP_W } from "./geometry";
import type { FontSpec } from "./textWidth";

export type WideUi = Pick<
	DialUi,
	"volume" | "muted" | "volumeDisplay" | "takeoverAlpha" | "flashDir" | "offset" | "sourceLabel" | "dimmed" | "badge" | "buffering" | "plate"
> & { message?: Message };

const CANVAS = { w: WIDE_W, h: STRIP_H };
const TEXT_X = WIDE_THUMB.x + WIDE_THUMB.size + 10;
const TEXT_W = WIDE_W - TEXT_X - 8;
const TITLE_Y = 21;
const ARTIST_Y = 43;
const TITLE_FONT: FontSpec = { size: 19, weight: 600 };
const ARTIST_FONT: FontSpec = { size: 14, weight: 400 };
const BARS_BASE = 66;
const SOURCE = { x: TEXT_X + 18, y: 60, font: { size: 11, weight: 400 } as FontSpec };
const ROW_Y = 85;
/** The right half's transport row: back, play state, forward, centred under the skip dial. */
const TRANSPORT = { back: STRIP_W + 50, mid: STRIP_W + 100, forward: STRIP_W + 150 };

const SVG_OPEN = (x: number) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="${STRIP_W}" height="${STRIP_H}" viewBox="${x} 0 ${STRIP_W} ${STRIP_H}">`;
const opacity = (a: number) => String(Math.round(a * 100) / 100);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** A play triangle (paused) or two bars (playing), centred on (cx, cy). */
function playState(playing: boolean, cx: number, cy: number): string {
	if (playing) {
		const bar = (x: number) => `<rect x="${n(x)}" y="${n(cy - 7)}" width="4" height="14" rx="1" ${white(0.85)}/>`;
		return bar(cx - 6) + bar(cx + 2);
	}
	return `<path d="M${n(cx - 5)} ${n(cy - 8)}L${n(cx + 8)} ${n(cy)}L${n(cx - 5)} ${n(cy + 8)}Z" ${white(0.85)}/>`;
}

function transportRow(playing: boolean, flashDir: -1 | 0 | 1, accent: Rgb): string {
	const paint = (dir: -1 | 1) => (flashDir === dir ? `fill="${css(accent)}"` : white(0.6));
	return (
		chevronPair(TRANSPORT.back, -1, paint(-1), ROW_Y) +
		playState(playing, TRANSPORT.mid, ROW_Y) +
		chevronPair(TRANSPORT.forward, 1, paint(1), ROW_Y)
	);
}

type Rest = { svg: string; bars: boolean; scrolls: boolean };

function restView(p: PlayerState, ui: WideUi, accent: Rgb, t: number): Rest {
	const title = p.title || p.friendlyName;
	const artist = p.title ? (p.artist ?? "") : statusWord(p.status);
	const top = marquee({ id: "wtitle", x: TEXT_X, w: TEXT_W }, title, TITLE_Y, TITLE_FONT, WHITE, ui.offset, CANVAS);
	const sub = artist
		? marquee({ id: "wartist", x: TEXT_X, w: TEXT_W }, artist, ARTIST_Y, ARTIST_FONT, white(0.72), ui.offset, CANVAS)
		: { svg: "", scrolls: false };
	const playing = p.status === "playing" || p.status === "buffering";
	let svg = top.svg + sub.svg;
	if (playing) svg += playBars(t, ui.buffering || p.status === "buffering", accent, TEXT_X, BARS_BASE);
	else if (p.title) svg += pauseGlyph(TEXT_X, BARS_BASE);
	if (ui.sourceLabel) {
		svg += marquee({ id: "wsource", x: SOURCE.x, w: WIDE_W - SOURCE.x - 8 }, ui.sourceLabel, SOURCE.y, SOURCE.font, white(0.6), 0, CANVAS).svg;
	}
	// The left bottom row is the dial's volume row, in the same place as on a single dial.
	svg += volumeRow({ ...ui, mode: "volume", message: undefined }, accent);
	svg += transportRow(playing, ui.flashDir, accent);
	return { svg, bars: playing, scrolls: top.scrolls || sub.scrolls };
}

/**
 * During the takeover the left half's text is covered, so the right half shows the track on its own:
 * a scrim over the rest view, the title and artist, and the transport row again on top.
 */
function trackPanel(p: PlayerState, ui: WideUi, accent: Rgb): string {
	const x = STRIP_W + 12;
	const box = (id: string) => ({ id, x, w: STRIP_W - 24 });
	const title = p.title || p.friendlyName;
	const artist = p.title ? (p.artist ?? "") : statusWord(p.status);
	let s = `<rect x="${STRIP_W}" y="0" width="${STRIP_W}" height="${STRIP_H}" fill="#000" fill-opacity="0.45"/>`;
	s += marquee(box("ptitle"), title, 20, { size: 17, weight: 600 }, WHITE, ui.offset, CANVAS).svg;
	if (artist) s += marquee(box("partist"), artist, 40, { size: 13, weight: 400 }, white(0.72), ui.offset, CANVAS).svg;
	return s + transportRow(p.status === "playing" || p.status === "buffering", ui.flashDir, accent);
}

/** Status and error messages beside the thumbnail, across the full width; never scrolls. */
function messageView(m: Message): string {
	const headFits = ellipsize(m.headline.trim(), TEXT_W, TITLE_FONT) === m.headline.trim();
	const head = headFits ? [m.headline.trim()] : wrap(m.headline, TITLE_FONT, 2, TEXT_W);
	let s = head.map((line, i) => text(TEXT_X, TITLE_Y + i * 22, TITLE_FONT, WHITE, escapeXml(line))).join("");
	if (m.sub) {
		const y = ARTIST_Y + (head.length - 1) * 22;
		s += wrap(m.sub, ARTIST_FONT, 2, TEXT_W)
			.map((line, i) => text(TEXT_X, y + i * 17, ARTIST_FONT, white(0.72), escapeXml(line)))
			.join("");
	}
	return s;
}

/**
 * The whole 400×100 drawing (without the `<svg>` wrapper) and its motion flags. The volume
 * takeover covers the left half only, so the track stays readable above the skip dial.
 */
export function renderWideBody(p: PlayerState | null, ui: WideUi, accent: Rgb, t: number): { body: string; animating: boolean; halfRate: boolean } {
	let body = "";
	let animating = false;
	let halfRate = false;
	if (ui.message) {
		body = messageView(ui.message);
	} else if (p) {
		const rest = restView(p, ui, accent, t);
		animating = rest.bars || rest.scrolls;
		halfRate = rest.bars && !rest.scrolls;
		body = rest.svg;
		const alpha = clamp(ui.takeoverAlpha, 0, 1);
		if (alpha > 0) {
			const over = takeover(p, { ...ui, mode: "volume", message: undefined }, accent) + trackPanel(p, ui, accent);
			body += alpha >= 1 ? over : `<g opacity="${opacity(alpha)}">${over}</g>`;
		}
	}
	if (ui.dimmed) body += `<rect x="0" y="0" width="${WIDE_W}" height="${STRIP_H}" fill="#000" opacity="0.5"/>`;
	if (ui.badge) body += badge(ui.badge, WIDE_W - 4);
	return { body, animating, halfRate };
}

/** The left and right halves' fg SVGs for one frame. */
export function renderWide(p: PlayerState | null, ui: WideUi, accent: Rgb, t: number): { halves: [Frame, Frame] } {
	const { body, animating, halfRate } = renderWideBody(p, ui, accent, t);
	const half = (x: number): Frame => ({ svg: `${SVG_OPEN(x)}${body}</svg>`, animating, halfRate });
	return { halves: [half(0), half(STRIP_W)] };
}
