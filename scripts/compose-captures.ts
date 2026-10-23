// Composes the README gallery and GIF from frames captured on a real Stream Deck+.
// Run with `npm run gallery:captures`.
//
// Captures come from a dev-only capture build (`SPINDLE_CAPTURE=1 npm run build`, see
// src/capture.ts), which writes every frame it sends to the repo's git-ignored `capture/` folder
// as `<n>-<dial>.json`: `{ t, dial, fg?, bg? }`, holding only the keys that frame sent. The bg is
// sent only when it changes, so a frame shows its own fg over the latest bg sent at or before it.
//
// Which frames become which image is set by the committed manifest docs/images/captures.json:
//
//   {
//     "rest":     { "frame": "capture/000123-0.json" },
//     "paused":   { "frame": "capture/000150-0.json" },
//     "takeover": { "frame": "capture/000171-2.json", "marketplace": "Volume" },
//     "gif":      { "from": "capture/000200-0.json", "to": "capture/000260-0.json", "fps": 10 },
//     "wide":     { "frame": "capture/000300-0.json" },
//     "wide-gif": { "from": "capture/000310-0.json", "to": "capture/000380-0.json", "fps": 5 },
//     "keys":     { "frames": ["capture/000400-100.json", "capture/000401-101.json"] }
//   }
//
// - Stills: rest, paused, takeover, tracks, cjk, no-art and hero, each written to
//   docs/images/<name>.png. `frame` is relative to the repo root.
// - A still can also ask for an Elgato Marketplace gallery image with `"marketplace": true` or
//   `"marketplace": "<caption>"` (at most 40 characters). That writes docs/images/marketplace/<name>.png,
//   1920x960: the same frame rendered at 4.5x (900x450) and centred on a darkened, heavily blurred copy
//   of its own backdrop, with the caption (if any) below it in Segoe UI.
// - "gif": docs/images/spindle.gif, sampling what that dial showed every 1000/fps ms (default 10,
//   at most 50) from the `from` frame's time to the `to` frame's. Both must be the same dial in the
//   same folder.
// - Wide stills, "wide" and "wide-takeover": `frame` is the LEFT half's capture. The right half is the
//   dial one column to its right, as it was at the same moment (both halves go out in the same
//   heartbeat). Written 1200x300 to docs/images/<name>.png.
// - "wide-gif": docs/images/wide.gif, both halves sampled together, from and to on the left dial.
// - "keys": docs/images/keys.png, the listed key captures (slot 100 + 10 x row + column, see
//   src/capture.ts) side by side, each at 216x216 (1.5x), in the listed order.
// - An image the manifest leaves out is left untouched (and `npm run screenshots` skips the ones it
//   lists, so it never overwrites a capture with a demo render).
//
// Each image is composed as the device composes it, at 3x (600x300): the 200x100 bg embedded as an
// <image> under the fg SVG, rasterised by resvg with the system fonts (scripts/gallery.ts).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Rgba } from "../src/art/image";
import { parseCaptureName } from "../src/capture";
import { Resvg } from "@resvg/resvg-js";
import { PNG } from "pngjs";
import { FONT, OUT, rasterise, rasteriseSvg, writeGif, writePng } from "./gallery";

export const MANIFEST = path.join(OUT, "captures.json");
const ROOT = path.resolve(import.meta.dirname, "..");
const STILLS = new Set(["rest", "paused", "takeover", "tracks", "cjk", "no-art", "hero"]);
const WIDE_STILLS = new Set(["wide", "wide-takeover"]);
/** Keys in keys.png: drawn at 144x144, shown at 1.5x, with a gap and margin between them. */
const KEY_SHOWN = 216;
const KEY_GAP = 24;
/**
 * The two halves of a Wide pair go out in the same heartbeat, but the right half is recorded a moment
 * later; anything within half a heartbeat after the left half counts as the same moment.
 */
const SAME_BEAT_MS = 50;
const DEFAULT_FPS = 10;
const MAX_FPS = 50;
const SVG_URI = "data:image/svg+xml,";
const MARKETPLACE_DIR = "marketplace";
const MARKETPLACE_W = 1920;
const MARKETPLACE_H = 960;
/** The strip at 4.5x: 900x450, so the 1920x960 canvas keeps generous margins. */
const MARKETPLACE_STRIP_W = 900;
const MAX_CAPTION = 40;

export type CaptureFrame = { n: number; dial: number; t: number; fg?: string; bg?: string; image?: string };
/** What the strip showed: an fg SVG data URI over a bg PNG data URI. */
export type Shown = { fg: string; bg: string };
/** `marketplace` maps a still's name to its caption ("" for none), for the stills that asked for a gallery image. */
type Sequence = { from: string; to: string; fps: number };
export type Manifest = {
	stills: Record<string, string>;
	marketplace?: Record<string, string>;
	gif?: Sequence;
	/** Wide stills by name: the left half's capture. */
	wide?: Record<string, string>;
	wideGif?: Sequence;
	keys?: string[];
};

/** The SVG inside the controller's `data:image/svg+xml,<percent-encoded>` fg. */
export function svgFromUri(uri: string): string {
	if (!uri.startsWith(SVG_URI)) throw new Error(`fg is not an SVG data URI: ${uri.slice(0, 32)}`);
	return decodeURIComponent(uri.slice(SVG_URI.length));
}

/** frames[i]'s fg and bg, or the latest ones sent before it. */
function shownThrough(frames: CaptureFrame[], i: number): Shown {
	let fg: string | undefined;
	let bg: string | undefined;
	for (let k = i; k >= 0 && (fg === undefined || bg === undefined); k--) {
		fg ??= frames[k].fg;
		bg ??= frames[k].bg;
	}
	const n = frames[i].n;
	if (fg === undefined) throw new Error(`no fg sent at or before frame ${n}`);
	if (bg === undefined) throw new Error(`no bg sent at or before frame ${n}; the capture ring may have pruned it, so pick a later frame`);
	return { fg, bg };
}

function indexOf(frames: CaptureFrame[], n: number): number {
	const i = frames.findIndex((f) => f.n === n);
	if (i < 0) throw new Error(`frame ${n} is not in the captures`);
	return i;
}

/** What the dial showed after frame n. `frames` is one dial's captures, sorted by n. */
export function shownAt(frames: CaptureFrame[], n: number): Shown {
	return shownThrough(frames, indexOf(frames, n));
}

/** What a dial showed at time `t`: its latest frame sent at or before `t`. */
export function shownAtTime(frames: CaptureFrame[], t: number): Shown {
	let i = -1;
	for (let k = 0; k < frames.length && frames[k].t <= t; k++) i = k;
	if (i < 0) throw new Error(`nothing was sent on dial ${frames[0]?.dial ?? "?"} at or before t=${t}`);
	return shownThrough(frames, i);
}

/** The sample times every 1000/fps ms, from frame `from`'s time through frame `to`'s. */
function sampleTimes(frames: CaptureFrame[], from: number, to: number, fps: number): number[] {
	const t0 = frames[indexOf(frames, from)].t;
	const t1 = frames[indexOf(frames, to)].t;
	if (t1 < t0) throw new Error(`gif: the "to" frame ${to} is before the "from" frame ${from}`);
	const out: number[] = [];
	for (let k = 0; t0 + k * (1000 / fps) <= t1; k++) out.push(t0 + k * (1000 / fps));
	return out;
}

/** What the dial showed every 1000/fps ms, from frame `from`'s time through frame `to`'s. */
export function sampleSequence(frames: CaptureFrame[], from: number, to: number, fps: number): Shown[] {
	const first = indexOf(frames, from);
	const last = indexOf(frames, to);
	if (last < first) throw new Error(`gif: the "to" frame ${to} is before the "from" frame ${from}`);
	const t0 = frames[first].t;
	const t1 = frames[last].t;
	const step = 1000 / fps;
	const out: Shown[] = [];
	let i = first;
	for (let k = 0; t0 + k * step <= t1; k++) {
		const t = t0 + k * step;
		while (i < last && frames[i + 1].t <= t) i++;
		out.push(shownThrough(frames, i));
	}
	return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function checkKeys(where: string, v: Record<string, unknown>, allowed: string[]): void {
	for (const key of Object.keys(v)) if (!allowed.includes(key)) throw new Error(`${where}: unknown key "${key}"`);
}

function str(where: string, v: unknown): string {
	if (typeof v !== "string" || v === "") throw new Error(`${where} must be a capture file path`);
	return v;
}

function sequence(name: string, entry: Record<string, unknown>): Sequence {
	checkKeys(name, entry, ["from", "to", "fps"]);
	const fps = entry.fps ?? DEFAULT_FPS;
	if (typeof fps !== "number" || !Number.isFinite(fps) || fps < 1 || fps > MAX_FPS) throw new Error(`${name}.fps must be a number from 1 to ${MAX_FPS}`);
	return { from: str(`${name}.from`, entry.from), to: str(`${name}.to`, entry.to), fps };
}

export function parseManifest(json: unknown): Manifest {
	if (!isObject(json)) throw new Error("the manifest must be a JSON object");
	const out: Manifest = { stills: {} };
	for (const [name, entry] of Object.entries(json)) {
		if (!isObject(entry)) throw new Error(`${name}: must be an object`);
		if (name === "gif") {
			out.gif = sequence(name, entry);
		} else if (name === "wide-gif") {
			out.wideGif = sequence(name, entry);
		} else if (WIDE_STILLS.has(name)) {
			checkKeys(name, entry, ["frame"]);
			(out.wide ??= {})[name] = str(`${name}.frame`, entry.frame);
		} else if (name === "keys") {
			checkKeys(name, entry, ["frames"]);
			const frames = entry.frames;
			if (!Array.isArray(frames) || frames.length === 0) throw new Error("keys.frames must be a non-empty list of capture file paths");
			out.keys = frames.map((f, i) => str(`keys.frames[${i}]`, f));
		} else {
			const known = [...STILLS, ...WIDE_STILLS, "gif", "wide-gif", "keys"];
			if (!STILLS.has(name)) throw new Error(`unknown output name "${name}"; use one of ${known.join(", ")}`);
			checkKeys(name, entry, ["frame", "marketplace"]);
			out.stills[name] = str(`${name}.frame`, entry.frame);
			if (entry.marketplace !== undefined) {
				const caption = entry.marketplace;
				if (caption !== true && (typeof caption !== "string" || caption === "" || caption.length > MAX_CAPTION)) {
					throw new Error(`${name}.marketplace must be true or a caption of 1 to ${MAX_CAPTION} characters`);
				}
				(out.marketplace ??= {})[name] = caption === true ? "" : caption;
			}
		}
	}
	return out;
}

const escapeXml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A 1920x960 Marketplace gallery image: the strip render, unscaled, centred over a darkened,
 * heavily blurred copy of the frame's own backdrop, with an optional caption beneath it.
 * `strip` is already rasterised at 900x450, so nothing is resampled here except the backdrop.
 */
export function composeMarketplace(bgUri: string, strip: Rgba, caption: string): Rgba {
	const stripPng = PNG.sync.write(Object.assign(new PNG({ width: strip.width, height: strip.height }), { data: Buffer.from(strip.data) }));
	const x = (MARKETPLACE_W - strip.width) / 2;
	const y = caption ? 190 : (MARKETPLACE_H - strip.height) / 2;
	const uri = `data:image/png;base64,${stripPng.toString("base64")}`;
	const text = caption
		? `<text x="${MARKETPLACE_W / 2}" y="${y + strip.height + 110}" text-anchor="middle" font-family="Segoe UI" font-size="56" font-weight="600" letter-spacing="2" fill="#ffffff" fill-opacity="0.92">${escapeXml(caption)}</text>`
		: "";
	// The backdrop is drawn past the canvas on every side so the blur has no transparent edge.
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${MARKETPLACE_W}" height="${MARKETPLACE_H}" viewBox="0 0 ${MARKETPLACE_W} ${MARKETPLACE_H}">
	<defs>
		<filter id="blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="70"/></filter>
		<filter id="shadow" x="-20%" y="-30%" width="140%" height="160%"><feGaussianBlur stdDeviation="28"/></filter>
		<clipPath id="strip"><rect x="${x}" y="${y}" width="${strip.width}" height="${strip.height}" rx="18"/></clipPath>
	</defs>
	<image x="-320" y="-160" width="2560" height="1280" preserveAspectRatio="xMidYMid slice" href="${bgUri}" filter="url(#blur)"/>
	<rect width="${MARKETPLACE_W}" height="${MARKETPLACE_H}" fill="#000000" fill-opacity="0.62"/>
	<rect x="${x}" y="${y + 22}" width="${strip.width}" height="${strip.height}" rx="18" fill="#000000" fill-opacity="0.55" filter="url(#shadow)"/>
	<image x="${x}" y="${y}" width="${strip.width}" height="${strip.height}" href="${uri}" clip-path="url(#strip)"/>
	${text}
</svg>`;
	const png = PNG.sync.read(new Resvg(svg, { fitTo: { mode: "width", value: MARKETPLACE_W }, font: FONT }).render().asPng());
	return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

/** The capture folder, counter and dial of a manifest frame path. */
function frameRef(ref: string): { dir: string; n: number; dial: number } {
	const file = path.resolve(ROOT, ref);
	const parsed = parseCaptureName(path.basename(file));
	if (!parsed) throw new Error(`${ref} is not a capture file name (<n>-<dial>.json)`);
	return { dir: path.dirname(file), ...parsed };
}

const loaded = new Map<string, CaptureFrame[]>();

/** Every capture for one dial in one folder, sorted by counter. */
function loadDial(dir: string, dial: number): CaptureFrame[] {
	const key = `${dir}\n${dial}`;
	const cached = loaded.get(key);
	if (cached) return cached;
	const frames: CaptureFrame[] = [];
	for (const name of fs.readdirSync(dir)) {
		const parsed = parseCaptureName(name);
		if (!parsed || parsed.dial !== dial) continue;
		const json: unknown = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
		if (!isObject(json) || typeof json.t !== "number") throw new Error(`${name}: not a capture frame`);
		frames.push({
			...parsed,
			t: json.t,
			...(typeof json.fg === "string" ? { fg: json.fg } : {}),
			...(typeof json.bg === "string" ? { bg: json.bg } : {}),
			...(typeof json.image === "string" ? { image: json.image } : {})
		});
	}
	frames.sort((a, b) => a.n - b.n);
	loaded.set(key, frames);
	return frames;
}

/** Rasterises each distinct frame once; a GIF often holds the same frame for several samples. */
function renderAll(shown: Shown[]): Rgba[] {
	const cache = new Map<string, Rgba>();
	return shown.map((s) => {
		const key = `${s.bg}\n${s.fg}`;
		let img = cache.get(key);
		if (!img) {
			img = rasterise(s.bg, svgFromUri(s.fg));
			cache.set(key, img);
		}
		return img;
	});
}

/** One Wide moment: the left half and the right half side by side, 400x100 drawn at 3x. */
function rasteriseWide(left: Shown, right: Shown): Rgba {
	const half = (s: Shown, x: number) =>
		`<image href="${s.bg}" x="${x}" y="0" width="200" height="100"/>${svgFromUri(s.fg).replace(/^<svg /, `<svg x="${x}" y="0" `)}`;
	return rasteriseSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100" viewBox="0 0 400 100">${half(left, 0)}${half(right, 200)}</svg>`, 1200);
}

/** Both halves of a Wide pair as they were at frame `ref` of the left half. */
function wideAt(ref: string): Rgba {
	const { dir, n, dial } = frameRef(ref);
	const left = loadDial(dir, dial);
	const t = left[indexOf(left, n)].t;
	return rasteriseWide(shownAt(left, n), shownAtTime(loadDial(dir, dial + 1), t + SAME_BEAT_MS));
}

/** The listed key captures in a row on a dark card. */
function keysRow(refs: string[]): Rgba {
	const images = refs.map((ref) => {
		const { dir, n, dial } = frameRef(ref);
		const frames = loadDial(dir, dial);
		let image: string | undefined;
		for (let i = indexOf(frames, n); i >= 0 && image === undefined; i--) image = frames[i].image;
		if (image === undefined) throw new Error(`${ref}: no key image sent at or before it (is it a key capture, slot 100+?)`);
		return svgFromUri(image);
	});
	const k = KEY_SHOWN / 144;
	const w = images.length * KEY_SHOWN + (images.length + 1) * KEY_GAP;
	const h = KEY_SHOWN + 2 * KEY_GAP;
	const body = images
		.map((svg, i) => {
			const x = KEY_GAP + i * (KEY_SHOWN + KEY_GAP);
			const id = `key${i}`;
			return `<clipPath id="${id}"><rect x="${x}" y="${KEY_GAP}" width="${KEY_SHOWN}" height="${KEY_SHOWN}" rx="${18 * k}"/></clipPath><g clip-path="url(#${id})">${svg.replace(/^<svg /, `<svg x="${x}" y="${KEY_GAP}" width="${KEY_SHOWN}" height="${KEY_SHOWN}" `).replace(/ width="144" height="144"/, "")}</g>`;
		})
		.join("");
	return rasteriseSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="24" fill="#1c1c1f"/>${body}</svg>`, w);
}

export function readManifest(): Manifest | null {
	return fs.existsSync(MANIFEST) ? parseManifest(JSON.parse(fs.readFileSync(MANIFEST, "utf8"))) : null;
}

function main(): number {
	const manifest = readManifest();
	if (!manifest) {
		console.error(`${path.relative(process.cwd(), MANIFEST)} not found; its format is at the top of scripts/compose-captures.ts`);
		return 1;
	}
	fs.mkdirSync(OUT, { recursive: true });
	for (const [name, ref] of Object.entries(manifest.stills)) {
		const { dir, n, dial } = frameRef(ref);
		const shown = shownAt(loadDial(dir, dial), n);
		const [img] = renderAll([shown]);
		writePng(`${name}.png`, img);
		const caption = manifest.marketplace?.[name];
		if (caption !== undefined) {
			fs.mkdirSync(path.join(OUT, MARKETPLACE_DIR), { recursive: true });
			const strip = rasterise(shown.bg, svgFromUri(shown.fg), MARKETPLACE_STRIP_W);
			writePng(`${MARKETPLACE_DIR}/${name}.png`, composeMarketplace(shown.bg, strip, caption));
		}
	}
	if (manifest.gif) {
		const { fps } = manifest.gif;
		const from = frameRef(manifest.gif.from);
		const to = frameRef(manifest.gif.to);
		if (from.dir !== to.dir || from.dial !== to.dial) throw new Error("gif: from and to must be the same dial in the same folder");
		const frames = renderAll(sampleSequence(loadDial(from.dir, from.dial), from.n, to.n, fps));
		writeGif("spindle.gif", frames, Math.round(1000 / fps));
	}
	for (const [name, ref] of Object.entries(manifest.wide ?? {})) writePng(`${name}.png`, wideAt(ref));
	if (manifest.wideGif) {
		const { fps } = manifest.wideGif;
		const from = frameRef(manifest.wideGif.from);
		const to = frameRef(manifest.wideGif.to);
		if (from.dir !== to.dir || from.dial !== to.dial) throw new Error("wide-gif: from and to must be the same (left) dial in the same folder");
		const left = loadDial(from.dir, from.dial);
		const right = loadDial(from.dir, from.dial + 1);
		const cache = new Map<string, Rgba>();
		const frames = sampleTimes(left, from.n, to.n, fps).map((t) => {
			const l = shownAtTime(left, t);
			const r = shownAtTime(right, t + SAME_BEAT_MS);
			const key = `${l.bg}${l.fg}${r.bg}${r.fg}`;
			let img = cache.get(key);
			if (!img) cache.set(key, (img = rasteriseWide(l, r)));
			return img;
		});
		writeGif("wide.gif", frames, Math.round(1000 / fps));
	}
	if (manifest.keys) writePng("keys.png", keysRow(manifest.keys));
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try {
		process.exitCode = main();
	} catch (err) {
		console.error(`gallery:captures: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
	}
}
