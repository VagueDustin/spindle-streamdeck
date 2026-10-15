// Golden renders: bg PNG + fg SVG composited through resvg with only the Noto Sans
// fixture loaded, compared against committed PNGs. Regenerate with
//   UPDATE_GOLDENS=1 npx vitest run test/render/golden.test.ts
// and inspect every image against spec 4.2 before committing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Rgba } from "../../src/art/image";
import { FALLBACK_ACCENT, pickAccent, type Rgb } from "../../src/art/accent";
import type { PlayerState } from "../../src/ha/playerState";
import { buildBackdrop } from "../../src/render/backdrop";
import { renderForeground, type DialUi } from "../../src/render/foreground";
import { compose, readPng, toPng } from "../helpers/compose";
import { make } from "../helpers/synth";

const DIR = "test/fixtures/goldens";
const UPDATE = process.env.UPDATE_GOLDENS === "1";
const TOLERANCE = 8;
const MAX_DIFF_SHARE = 0.005;

/** A deterministic "cover": a dusk gradient with a warm disc, generated in code. */
const COVER = make(240, 240, (x, y) => {
	const d = Math.hypot(x - 150, y - 100);
	if (d < 55) return [250, 150 + Math.round(d), 60];
	return [40 + Math.round(x / 4), 30 + Math.round(y / 6), 110 + Math.round(y / 3)];
});
const ACCENT: Rgb = pickAccent(COVER);

const player = (over: Partial<PlayerState> = {}): PlayerState => ({
	entityId: "media_player.living_room",
	status: "playing",
	friendlyName: "Living Room",
	title: "Night Drive",
	artist: "The Example Band",
	volume: 42,
	muted: false,
	features: 0,
	...over
});

const ui = (over: Partial<DialUi> = {}): DialUi => ({
	mode: "volume",
	volume: 42,
	muted: false,
	volumeDisplay: "number",
	takeoverAlpha: 0,
	flashDir: 0,
	offset: 0,
	sourceLabel: "Spotify",
	dimmed: false,
	buffering: false,
	...over
});

type Scenario = { cover: Rgba | null; accent: Rgb; p: PlayerState | null; ui: DialUi };

const SCENARIOS: Record<string, Scenario> = {
	"rest-playing": { cover: COVER, accent: ACCENT, p: player(), ui: ui() },
	"rest-paused": { cover: COVER, accent: ACCENT, p: player({ status: "paused" }), ui: ui() },
	takeover: { cover: COVER, accent: ACCENT, p: player(), ui: ui({ takeoverAlpha: 1, volume: 64 }) },
	tracks: { cover: COVER, accent: ACCENT, p: player(), ui: ui({ mode: "tracks", flashDir: 1 }) },
	"no-art": { cover: null, accent: FALLBACK_ACCENT, p: player(), ui: ui() },
	"message-check-token": { cover: null, accent: FALLBACK_ACCENT, p: null, ui: ui({ message: { headline: "Check token" } }) },
	"long-title-offset-40": {
		cover: COVER,
		accent: ACCENT,
		p: player({ title: "A Remarkably Long Title For A Song" }),
		ui: ui({ offset: 40 })
	}
};

function diffShare(a: Rgba, b: Rgba): number {
	let bad = 0;
	for (let i = 0; i < a.data.length; i += 4) {
		for (let c = 0; c < 4; c++) {
			if (Math.abs(a.data[i + c] - b.data[i + c]) > TOLERANCE) {
				bad++;
				break;
			}
		}
	}
	return bad / (a.width * a.height);
}

describe("golden renders", () => {
	for (const [name, s] of Object.entries(SCENARIOS)) {
		test(name, () => {
			const fg = renderForeground(s.p, s.ui, s.accent, 0).svg;
			const img = compose(buildBackdrop(s.cover, s.accent), fg);
			const path = `${DIR}/${name}.png`;
			if (UPDATE) {
				mkdirSync(DIR, { recursive: true });
				writeFileSync(path, toPng(img));
				return;
			}
			expect(existsSync(path), `missing golden ${path}; run with UPDATE_GOLDENS=1`).toBe(true);
			const want = readPng(readFileSync(path));
			expect([img.width, img.height]).toEqual([want.width, want.height]);
			expect(diffShare(img, want)).toBeLessThanOrEqual(MAX_DIFF_SHARE);
		});
	}
});
