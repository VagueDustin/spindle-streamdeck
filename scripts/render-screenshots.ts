// Renders the README gallery and GIF from the real renderer. Run with `npm run screenshots`.
//
// Each image is composed as the device composes it: the `bg` PNG from buildBackdrop under the
// `fg` SVG from renderForeground, with the takeover plate supplied as the controller supplies it,
// rasterised at 3x (600x300) by scripts/gallery.ts. The covers are abstract, generated here from
// fixed seeds; the track and artist names are made up.
//
// The README shows real captures where docs/images/captures.json lists them (`npm run
// gallery:captures`); this script skips those, so it never overwrites a capture. It stays for
// development and for whatever the manifest does not provide (hero.png, until a capture or photo).
import fs from "node:fs";
import path from "node:path";
import { FALLBACK_ACCENT, pickAccent, type Rgb } from "../src/art/accent";
import type { Rgba } from "../src/art/image";
import { DialController, SCROLL_STEP_PX } from "../src/dial/controller";
import { Feature, type PlayerState } from "../src/ha/playerState";
import { buildBackdrop, buildTakeoverPlate } from "../src/render/backdrop";
import { renderForeground, type DialUi } from "../src/render/foreground";
import { estimateWidth } from "../src/render/textWidth";
import { resolveDialSettings } from "../src/settings";
import { readManifest } from "./compose-captures";
import { OUT, rasterise, writeGif, writePng } from "./gallery";

const COVER_SIZE = 240;
const GIF_FRAME_MS = 100;
const GIF_FRAMES = 30;

// --- demo covers ------------------------------------------------------------

/** mulberry32: a small seeded PRNG, so every run draws the same covers. */
function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

type CoverStyle = { seed: number; top: Rgb; bottom: Rgb; blobs: Rgb[]; stripe: Rgb; stripeAngle: number };

const mix = (a: number, b: number, k: number) => a + (b - a) * k;

/** A vertical two-colour gradient, soft colour blobs, then a band of translucent diagonal stripes. */
function makeCover(style: CoverStyle): Rgba {
	const rand = prng(style.seed);
	const blobs = style.blobs.map((colour) => ({
		colour,
		x: rand() * COVER_SIZE,
		y: rand() * COVER_SIZE,
		r: COVER_SIZE * (0.2 + rand() * 0.16)
	}));
	const period = 14 + rand() * 10;
	const bandCentre = COVER_SIZE * (0.35 + rand() * 0.3);
	const bandHalf = COVER_SIZE * 0.16;
	const cos = Math.cos(style.stripeAngle);
	const sin = Math.sin(style.stripeAngle);
	const data = new Uint8Array(COVER_SIZE * COVER_SIZE * 4);
	for (let y = 0; y < COVER_SIZE; y++) {
		for (let x = 0; x < COVER_SIZE; x++) {
			const k = y / (COVER_SIZE - 1);
			let rgb = [0, 1, 2].map((c) => mix(style.top[c], style.bottom[c], k));
			for (const b of blobs) {
				const w = Math.exp(-((x - b.x) ** 2 + (y - b.y) ** 2) / (2 * b.r * b.r)) * 0.95;
				rgb = rgb.map((v, c) => mix(v, b.colour[c], w));
			}
			// Stripes run along the angle, inside a band across the cover that fades at its edges.
			const across = x * cos + y * sin;
			const along = -x * sin + y * cos + COVER_SIZE / 2;
			const band = Math.max(0, 1 - Math.abs(along - bandCentre) / bandHalf);
			const on = (across / period) % 1 < 0.45 ? 1 : 0;
			const sk = on * Math.min(1, band * 1.6) * 0.75;
			rgb = rgb.map((v, c) => mix(v, style.stripe[c], sk));
			const o = (y * COVER_SIZE + x) * 4;
			data[o] = Math.round(rgb[0]);
			data[o + 1] = Math.round(rgb[1]);
			data[o + 2] = Math.round(rgb[2]);
			data[o + 3] = 255;
		}
	}
	return { width: COVER_SIZE, height: COVER_SIZE, data };
}

const COVERS = {
	dusk: makeCover({ seed: 11, top: [52, 36, 120], bottom: [20, 70, 110], blobs: [[250, 120, 60], [190, 60, 120]], stripe: [255, 200, 120], stripeAngle: 0.6 }),
	orchid: makeCover({ seed: 23, top: [110, 30, 110], bottom: [40, 20, 90], blobs: [[230, 70, 200], [120, 60, 230], [255, 150, 210]], stripe: [250, 220, 250], stripeAngle: -0.9 }),
	fern: makeCover({ seed: 37, top: [20, 90, 70], bottom: [14, 50, 36], blobs: [[110, 220, 120], [220, 230, 90]], stripe: [190, 240, 150], stripeAngle: 1.2 }),
	tide: makeCover({ seed: 53, top: [24, 70, 150], bottom: [10, 34, 80], blobs: [[60, 180, 240], [240, 200, 80]], stripe: [200, 240, 255], stripeAngle: 0.15 })
};

// --- scenes -----------------------------------------------------------------

const ENTITY = "media_player.living_room";
const FEATURES = Feature.VOLUME_SET | Feature.VOLUME_STEP | Feature.VOLUME_MUTE | Feature.NEXT_TRACK | Feature.PREVIOUS_TRACK | Feature.PAUSE | Feature.PLAY;

const player = (over: Partial<PlayerState>): PlayerState => ({
	entityId: ENTITY,
	status: "playing",
	friendlyName: "Living Room",
	volume: 42,
	muted: false,
	features: FEATURES,
	...over
});

const ui = (over: Partial<DialUi>): DialUi => ({
	mode: "volume",
	volume: 42,
	muted: false,
	volumeDisplay: "number",
	takeoverAlpha: 0,
	flashDir: 0,
	offset: 0,
	dimmed: false,
	buffering: false,
	...over
});

type Scene = { cover: Rgba | null; p: PlayerState; ui: DialUi; t: number };

const SCENES: Record<string, Scene> = {
	rest: {
		cover: COVERS.dusk,
		p: player({ title: "WE ARE EMPIRE", artist: "STARSET" }),
		ui: ui({ sourceLabel: "Turntable" }),
		t: 1800
	},
	takeover: {
		cover: COVERS.orchid,
		p: player({ title: "Postcards to Saturn", artist: "The Lantern Orbit" }),
		ui: ui({ sourceLabel: "Radio", takeoverAlpha: 1, volume: 64 }),
		t: 0
	},
	tracks: {
		cover: COVERS.fern,
		p: player({ title: "Fern Logic", artist: "Juniper Glass Club" }),
		ui: ui({ sourceLabel: "Network", mode: "tracks", flashDir: 1 }),
		t: 900
	},
	paused: {
		cover: COVERS.tide,
		p: player({ status: "paused", title: "Tide Theory", artist: "Copper Kettle Choir" }),
		ui: ui({ sourceLabel: "Turntable", volume: 28 }),
		t: 0
	},
	cjk: {
		cover: COVERS.orchid,
		p: player({ title: "灯台の時計", artist: "星屑テレグラフ" }),
		ui: ui({ sourceLabel: "Network", volume: 55 }),
		t: 2600
	},
	"no-art": {
		cover: null,
		p: player({ title: "Fog Index", artist: "Paper Lighthouse" }),
		ui: ui({ sourceLabel: "Radio", volume: 36 }),
		t: 400
	}
};

// --- rendering --------------------------------------------------------------

function renderScene(s: Scene): Rgba {
	const accent = s.cover ? pickAccent(s.cover) : FALLBACK_ACCENT;
	const fg = renderForeground(s.p, { ...s.ui, plate: buildTakeoverPlate(s.cover, accent) }, accent, s.t).svg;
	return rasterise(buildBackdrop(s.cover, accent), fg);
}

// --- GIF: a volume takeover fading out, the marquee scrolling, then the takeover again ---

const SVG_URI = "data:image/svg+xml,";
/** Too long for the rest view's title box, so it scrolls; short enough to sit still in the takeover's. */
const GIF_TITLE = "WE ARE EMPIRE";
/** Detents by frame (negative frames are before the clip): +1 to 48, then +1 and -1 back to 48. */
const DETENTS = new Map<number, number>([
	[-12, 1],
	[18, 1],
	[20, -1]
]);

/**
 * Drives a real DialController on a 100 ms clock, as the frame loop does, with HA echoing each
 * volume_set. The clip opens on the held takeover from frame -12's detent at 48, which fades over
 * frames 4 and 5. The rest view scrolls the title until the dial turns at frame 18, and the clip
 * ends held on the takeover at 48 again. The takeover is static at full alpha, so the last frame
 * matches the first and the loop closes cleanly; gifFrames() checks that.
 */
function gifFrames(): Rgba[] {
	let clock = 0;
	let haVolume = 46;
	const dial = new DialController(
		{
			now: () => clock,
			call: async (service, data) => {
				if (service === "volume_set") haVolume = Math.round(Number(data?.volume_level) * 100);
			},
			alert: () => {},
			renderMode: "layered"
		},
		resolveDialSettings({ entityId: ENTITY, sourceLabels: "Line In = Turntable" })
	);
	const cover = COVERS.dusk;
	let state = player({ title: GIF_TITLE, artist: "STARSET", source: "Line In", volume: haVolume });
	dial.setConnStatus({ kind: "connected", haVersion: "2025.10.0" });
	dial.setPlayer(state);
	dial.setCover({ key: "demo-dusk", image: cover, accent: pickAccent(cover) });

	// The wrapped copy enters the 120 px title box once the offset passes width + 28 - 120 (28 px is
	// the marquee gap). Warm up to two frames past that, so the copy is coming in as the rest view
	// returns at frame 6.
	const titleWidth = estimateWidth(GIF_TITLE, { size: 17, weight: 600 });
	const warmup = Math.max(12, Math.round((titleWidth + 28 - 120) / SCROLL_STEP_PX) - 2);
	let bg = "";
	let fg = "";
	const frames: Rgba[] = [];
	for (let i = -warmup; i < GIF_FRAMES; i++) {
		clock = (i + warmup) * GIF_FRAME_MS;
		if (state.volume !== haVolume) {
			state = { ...state, volume: haVolume };
			dial.setPlayer(state);
		}
		const detent = DETENTS.get(i);
		if (detent) dial.rotate(detent);
		dial.tick(clock);
		const payload = dial.frame(clock);
		if (payload?.bg) bg = payload.bg;
		if (payload?.fg) fg = decodeURIComponent(payload.fg.slice(SVG_URI.length));
		if (i >= 0) frames.push(rasterise(bg, fg));
	}
	const first = frames[0].data;
	const last = frames[frames.length - 1].data;
	if (first.length !== last.length || first.some((v, k) => v !== last[k])) {
		throw new Error("GIF loop: the last frame does not match the first");
	}
	return frames;
}

// Outputs the capture manifest provides ("spindle" is the GIF) are left alone.
const manifest = readManifest();
const captured = new Set([...Object.keys(manifest?.stills ?? {}), ...(manifest?.gif ? ["spindle"] : [])]);
if (captured.size > 0) console.log(`skipped, captured (docs/images/captures.json): ${[...captured].join(", ")}`);
// Until the hardware photo (hero.jpg) lands, the README hero is the rest render.
const heroFromRest = !fs.existsSync(path.join(OUT, "hero.jpg"));

fs.mkdirSync(OUT, { recursive: true });
for (const [name, scene] of Object.entries(SCENES)) {
	const outputs = [name, ...(name === "rest" && heroFromRest ? ["hero"] : [])].filter((o) => !captured.has(o));
	if (outputs.length === 0) continue;
	const img = renderScene(scene);
	for (const o of outputs) writePng(`${o}.png`, img);
}
if (!captured.has("spindle")) writeGif("spindle.gif", gifFrames(), GIF_FRAME_MS);
