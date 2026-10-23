import type { ControllerDeps } from "../../src/dial/controller";
import type { ConnStatus } from "../../src/ha/connection";
import { Feature, type PlayerState } from "../../src/ha/playerState";
import { SKIP_TICKS, VOLUME_DEBOUNCE_MS } from "../../src/player/session";
import { WideController } from "../../src/wide/controller";

const CONNECTED: ConnStatus = { kind: "connected", haVersion: "2026.10.0" };
const SVG_PREFIX = "data:image/svg+xml,";
const ALL = Feature.VOLUME_SET | Feature.VOLUME_MUTE | Feature.NEXT_TRACK | Feature.PREVIOUS_TRACK;

const player = (over: Partial<PlayerState> = {}): PlayerState => ({
	entityId: "media_player.den",
	status: "playing",
	friendlyName: "Den",
	title: "Song",
	artist: "Band",
	volume: 40,
	muted: false,
	features: ALL,
	...over
});

function setup(p: Partial<PlayerState> = {}, tapToSkip = true) {
	let now = 1_000_000;
	const call = vi.fn<ControllerDeps["call"]>(async () => {});
	const alert = vi.fn();
	const w = new WideController({ now: () => now, call, alert }, { entityId: "media_player.den", volumeStep: 2, labels: new Map(), tapToSkip });
	w.setConnStatus(CONNECTED);
	w.setPlayer(player(p));
	const advance = (ms: number) => {
		now += ms;
		w.tick(now);
	};
	return { w, call, alert, advance, now: () => now };
}

const svg = (payload: Record<string, string>) => decodeURIComponent(payload.fg.slice(SVG_PREFIX.length));

describe("WideController controls", () => {
	it("left turn sets the volume (debounced) and shows the takeover", () => {
		const { w, call, advance } = setup();
		w.rotateVolume(3);
		expect(w.ui.volume).toBe(46);
		expect(w.ui.takeoverAlpha).toBe(1);
		advance(VOLUME_DEBOUNCE_MS);
		expect(call).toHaveBeenCalledWith("volume_set", { volume_level: 0.46 });
	});

	it("left press toggles mute", () => {
		const { w, call } = setup();
		w.pressMute();
		expect(call).toHaveBeenCalledWith("volume_mute", { is_volume_muted: true });
		expect(w.ui.muted).toBe(true);
	});

	it("right turn skips after SKIP_TICKS detents and flashes that chevron", () => {
		const { w, call } = setup();
		w.rotateSkip(SKIP_TICKS - 1);
		expect(call).not.toHaveBeenCalled();
		w.rotateSkip(1);
		expect(call).toHaveBeenCalledWith("media_next_track", undefined);
		expect(w.ui.flashDir).toBe(1);
	});

	it("right press plays or pauses", () => {
		const { w, call } = setup();
		w.playPause();
		expect(call).toHaveBeenCalledWith("media_play_pause", undefined);
	});

	it.each([
		["left", 10, "media_previous_track"],
		["left", 150, "media_play_pause"],
		["right", 50, "media_play_pause"],
		["right", 150, "media_next_track"]
	] as const)("tap zones across 400 px: %s half at x=%i sends %s", (side, x, service) => {
		const { w, call } = setup();
		w.tap(side, x);
		expect(call).toHaveBeenCalledWith(service, undefined);
	});

	it("a tap skip flashes that chevron", () => {
		const { w } = setup();
		w.tap("right", 190);
		expect(w.ui.flashDir).toBe(1);
	});

	it("with tap zones off, a tap anywhere plays or pauses", () => {
		const { w, call } = setup({}, false);
		w.tap("right", 190);
		expect(call).toHaveBeenCalledWith("media_play_pause", undefined);
	});

	it("steps the marquee at 40 px/s (8 px per 5 fps frame)", () => {
		const { w, now } = setup({ title: "A title far too long to fit across the whole wide strip at nineteen pixels, really" });
		w.frame(now());
		expect(w.ui.offset).toBe(8);
	});

	it("refuses input with an alert while not connected", () => {
		const { w, call, alert } = setup();
		w.setConnStatus({ kind: "connecting" });
		w.rotateVolume(1);
		w.pressMute();
		expect(call).not.toHaveBeenCalled();
		expect(alert).toHaveBeenCalled();
	});
});

describe("WideController frames", () => {
	it("sends both halves of one drawing, offset by 200 px, with the backdrop halves first time only", () => {
		const { w, now } = setup();
		expect(w.urgent()).toBe(true);
		const first = w.frame(now())!;
		expect(first).toHaveLength(2);
		const [left, right] = first.map(svg);
		expect(left).toContain('viewBox="0 0 200 100"');
		expect(right).toContain('viewBox="200 0 200 100"');
		// Same body: only the viewBox differs, so text crossing the seam lines up.
		expect(left.replace('viewBox="0 0', "")).toBe(right.replace('viewBox="200 0', ""));
		expect(first[0].bg).toMatch(/^data:image\/png;base64,/);
		expect(first[1].bg).toMatch(/^data:image\/png;base64,/);
		expect(first[0].bg).not.toBe(first[1].bg);
		w.setPlayer(player({ title: "Next" }));
		const second = w.frame(now())!;
		expect(second[0].bg).toBeUndefined();
	});

	it("has nothing to send when nothing changed and nothing moves", () => {
		const { w, now } = setup({ status: "paused" });
		w.frame(now());
		expect(w.priority(now())).toBe("none");
		expect(w.frame(now())).toBeNull();
	});

	it("shows status messages across the pair", () => {
		const { w, now } = setup();
		w.setPlayer(null);
		const [left] = w.frame(now())!.map(svg);
		expect(left).toContain("Player not found");
	});
});
