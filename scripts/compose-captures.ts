// Composes the README gallery and GIF from frames captured on a real Stream Deck+ (ruling R29).
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
//     "takeover": { "frame": "capture/000171-2.json" },
//     "gif":      { "from": "capture/000200-0.json", "to": "capture/000260-0.json", "fps": 10 }
//   }
//
// - Stills: rest, paused, takeover, tracks, cjk, no-art and hero, each written to
//   docs/images/<name>.png. `frame` is relative to the repo root.
// - "gif": docs/images/spindle.gif, sampling what that dial showed every 1000/fps ms (default 10,
//   at most 50) from the `from` frame's time to the `to` frame's. Both must be the same dial in the
//   same folder.
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
import { OUT, rasterise, writeGif, writePng } from "./gallery";

export const MANIFEST = path.join(OUT, "captures.json");
const ROOT = path.resolve(import.meta.dirname, "..");
const STILLS = new Set(["rest", "paused", "takeover", "tracks", "cjk", "no-art", "hero"]);
const DEFAULT_FPS = 10;
const MAX_FPS = 50;
const SVG_URI = "data:image/svg+xml,";

export type CaptureFrame = { n: number; dial: number; t: number; fg?: string; bg?: string };
/** What the strip showed: an fg SVG data URI over a bg PNG data URI. */
export type Shown = { fg: string; bg: string };
export type Manifest = { stills: Record<string, string>; gif?: { from: string; to: string; fps: number } };

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

export function parseManifest(json: unknown): Manifest {
	if (!isObject(json)) throw new Error("the manifest must be a JSON object");
	const out: Manifest = { stills: {} };
	for (const [name, entry] of Object.entries(json)) {
		if (!isObject(entry)) throw new Error(`${name}: must be an object`);
		if (name === "gif") {
			checkKeys(name, entry, ["from", "to", "fps"]);
			const fps = entry.fps ?? DEFAULT_FPS;
			if (typeof fps !== "number" || !Number.isFinite(fps) || fps < 1 || fps > MAX_FPS) throw new Error(`gif.fps must be a number from 1 to ${MAX_FPS}`);
			out.gif = { from: str("gif.from", entry.from), to: str("gif.to", entry.to), fps };
		} else {
			if (!STILLS.has(name)) throw new Error(`unknown output name "${name}"; use one of ${[...STILLS].join(", ")} or gif`);
			checkKeys(name, entry, ["frame"]);
			out.stills[name] = str(`${name}.frame`, entry.frame);
		}
	}
	return out;
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
			...(typeof json.bg === "string" ? { bg: json.bg } : {})
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
		const [img] = renderAll([shownAt(loadDial(dir, dial), n)]);
		writePng(`${name}.png`, img);
	}
	if (manifest.gif) {
		const { fps } = manifest.gif;
		const from = frameRef(manifest.gif.from);
		const to = frameRef(manifest.gif.to);
		if (from.dir !== to.dir || from.dial !== to.dial) throw new Error("gif: from and to must be the same dial in the same folder");
		const frames = renderAll(sampleSequence(loadDial(from.dir, from.dial), from.n, to.n, fps));
		writeGif("spindle.gif", frames, Math.round(1000 / fps));
	}
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
