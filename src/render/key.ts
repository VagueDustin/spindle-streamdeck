// Key images: 144×144 SVGs (the deck scales them down for 72×72 keys), sent with setImage. Keys are
// read at a glance, so status messages are cut to a word or two and nothing is smaller than 15 px.
import type { Rgb } from "../art/accent";
import type { PlayerState } from "../ha/playerState";
import { CHECK_TOKEN, CONNECTING, NOT_FOUND, SETUP, type View } from "../player/session";
import type { CoverDisplay, TransportFunction } from "../settings";
import { css, escapeXml, marquee, text, white, WHITE, wrap } from "./foreground";
import type { FontSpec } from "./textWidth";

export const KEY = 144;
const CANVAS = { w: KEY, h: KEY };
const PAD = 10;
const INNER = KEY - 2 * PAD;
const SVG_OPEN = `<svg xmlns="http://www.w3.org/2000/svg" width="${KEY}" height="${KEY}" viewBox="0 0 ${KEY} ${KEY}">`;
const full = (attrs: string) => `<rect x="0" y="0" width="${KEY}" height="${KEY}" ${attrs}/>`;
const DIM = full('fill="#000" opacity="0.55"');
const RED = "rgb(255,110,110)";

/** The session's messages, cut to fit a key. */
const SHORT: Record<string, string> = {
	[SETUP]: "Set up",
	[CHECK_TOKEN]: "Check token",
	[CONNECTING]: "…",
	[NOT_FOUND]: "Not found"
};

export type KeyFrame = { svg: string; animating: boolean };

/** The one or two words a key shows for this view instead of the player, if any. */
export function keyCaption(v: View): string | undefined {
	if (v.message) return SHORT[v.message.headline] ?? v.message.headline;
	if (v.badge) return "…";
	const p = v.player;
	if (!p) return undefined;
	if (p.status === "unavailable" || p.status === "unknown") return "Offline";
	if (p.status === "off") return "Off";
	return undefined;
}

/** Centred words near the bottom, on a dark pill so they read over any art. */
function caption(word: string, y = 118): string {
	const font: FontSpec = { size: 20, weight: 700 };
	return `<rect x="${PAD}" y="${y - 16}" width="${INNER}" height="32" rx="10" fill="#000" fill-opacity="0.6"/>${text(KEY / 2, y, font, WHITE, escapeXml(word), ' text-anchor="middle"')}`;
}

const accentFill = (accent: Rgb, k: number) => `fill="${css([Math.round(accent[0] * k), Math.round(accent[1] * k), Math.round(accent[2] * k)])}"`;

// --- Cover ---

export type CoverKeyInput = {
	view: View;
	/** The cover fitted to 144×144, as a PNG data URI; null when there is none. */
	art: string | null;
	accent: Rgb;
	display: CoverDisplay;
	offset: number;
};

/** Three short accent bars in a dark pill at the bottom left: playing. Static, so a playing key costs no sends. */
function playingBadge(accent: Rgb): string {
	let s = `<rect x="${PAD}" y="${KEY - PAD - 30}" width="42" height="30" rx="8" fill="#000" fill-opacity="0.6"/>`;
	[14, 22, 10].forEach((h, i) => {
		s += `<rect x="${PAD + 9 + i * 9}" y="${KEY - PAD - 7 - h}" width="6" height="${h}" rx="2" fill="${css(accent)}"/>`;
	});
	return s;
}

/** Two bars in a dark circle at the bottom right: paused. */
function pausedBadge(): string {
	const cx = KEY - PAD - 18;
	const cy = KEY - PAD - 18;
	return (
		`<circle cx="${cx}" cy="${cy}" r="18" fill="#000" fill-opacity="0.6"/>` +
		`<rect x="${cx - 8}" y="${cy - 9}" width="6" height="18" rx="1.5" ${WHITE}/><rect x="${cx + 2}" y="${cy - 9}" width="6" height="18" rx="1.5" ${WHITE}/>`
	);
}

function stateBadge(p: PlayerState, accent: Rgb): string {
	if (p.status === "playing" || p.status === "buffering") return playingBadge(accent);
	if (p.title && p.status === "paused") return pausedBadge();
	return "";
}

const TITLE_FONT: FontSpec = { size: 20, weight: 700 };
const ARTIST_FONT: FontSpec = { size: 16, weight: 400 };

export function renderCoverKey(k: CoverKeyInput): KeyFrame {
	const p = k.view.player;
	const word = keyCaption(k.view);
	let s = k.display === "text" || !k.art ? full(accentFill(k.accent, 0.35)) : "";
	if (k.art && k.display !== "text") s += `<image href="${escapeXml(k.art)}" x="0" y="0" width="${KEY}" height="${KEY}"/>`;
	let animating = false;

	if (!p || word) {
		if (k.view.dimmed || p) s += DIM;
		if (word) s += caption(word, p ? 118 : KEY / 2);
		return { svg: `${SVG_OPEN}${s}</svg>`, animating };
	}

	const title = p.title || p.friendlyName;
	if (k.display === "text") {
		const lines = wrap(title, TITLE_FONT, 3, INNER);
		s += lines.map((line, i) => text(PAD, 26 + i * 24, TITLE_FONT, WHITE, escapeXml(line))).join("");
		if (p.artist && p.title) {
			const y = 26 + lines.length * 24 + 6;
			s += wrap(p.artist, ARTIST_FONT, lines.length > 2 ? 1 : 2, INNER)
				.map((line, i) => text(PAD, y + i * 19, ARTIST_FONT, white(0.75), escapeXml(line)))
				.join("");
		}
	} else if (k.display === "art-title") {
		s += `<rect x="0" y="${KEY - 40}" width="${KEY}" height="40" fill="#000" fill-opacity="0.65"/>`;
		const m = marquee({ id: "ktitle", x: PAD, w: INNER }, title, KEY - 20, TITLE_FONT, WHITE, k.offset, CANVAS);
		s += m.svg;
		animating = m.scrolls;
	} else if (k.display === "art") {
		s += stateBadge(p, k.accent);
	}
	return { svg: `${SVG_OPEN}${s}</svg>`, animating };
}

// --- Transport ---

export type TransportKeyInput = {
	view: View;
	fn: TransportFunction;
	accent: Rgb;
	/** The player can do this function. */
	supported: boolean;
	playing: boolean;
	muted: boolean;
	volume: number;
	/** Whether to print the volume number (VOLUME_SET players). */
	showVolume: boolean;
};

const GLYPH_Y = 62;
const speaker = (paint: string) => `<path d="M30 ${GLYPH_Y - 12}H46L68 ${GLYPH_Y - 30}V${GLYPH_Y + 30}L46 ${GLYPH_Y + 12}H30Z" ${paint}/>`;
const stroke = (d: string, color: string) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"/>`;

function glyph(k: TransportKeyInput, paint: string, color: string): string {
	const y = GLYPH_Y;
	switch (k.fn) {
		case "playpause":
			return k.playing
				? `<rect x="50" y="${y - 26}" width="14" height="52" rx="3" ${paint}/><rect x="80" y="${y - 26}" width="14" height="52" rx="3" ${paint}/>`
				: `<path d="M52 ${y - 30}L100 ${y}L52 ${y + 30}Z" ${paint}/>`;
		case "next":
			return `<path d="M36 ${y - 24}L70 ${y}L36 ${y + 24}ZM70 ${y - 24}L104 ${y}L70 ${y + 24}Z" ${paint}/><rect x="104" y="${y - 24}" width="8" height="48" rx="2" ${paint}/>`;
		case "previous":
			return `<path d="M108 ${y - 24}L74 ${y}L108 ${y + 24}ZM74 ${y - 24}L40 ${y}L74 ${y + 24}Z" ${paint}/><rect x="32" y="${y - 24}" width="8" height="48" rx="2" ${paint}/>`;
		case "mute":
			return k.muted
				? speaker(`fill="${RED}"`) + stroke(`M84 ${y - 14}L112 ${y + 14}M112 ${y - 14}L84 ${y + 14}`, RED)
				: speaker(paint) + stroke(`M82 ${y - 14}Q92 ${y} 82 ${y + 14}`, color) + stroke(`M94 ${y - 26}Q112 ${y} 94 ${y + 26}`, color);
		case "volume_up":
			return speaker(paint) + stroke(`M84 ${y}H112M98 ${y - 14}V${y + 14}`, color);
		case "volume_down":
			return speaker(paint) + stroke(`M84 ${y}H112`, color);
	}
}

export function renderTransportKey(k: TransportKeyInput): KeyFrame {
	const word = keyCaption(k.view);
	const usable = k.supported && !word;
	const color = usable ? "#fff" : "rgba(255,255,255,0.3)";
	const paint = usable ? WHITE : white(0.3);
	let s = full('fill="#000"') + glyph(k, paint, color);
	if (word) s += caption(word);
	else if ((k.fn === "volume_up" || k.fn === "volume_down") && k.showVolume) {
		s += text(KEY / 2, 122, { size: 22, weight: 700 }, k.muted ? `fill="${RED}"` : `fill="${css(k.accent)}"`, k.muted ? "MUTE" : String(Math.round(k.volume)), ' text-anchor="middle"');
	}
	return { svg: `${SVG_OPEN}${s}</svg>`, animating: false };
}

