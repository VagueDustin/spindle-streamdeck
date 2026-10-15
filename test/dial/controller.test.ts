import type { Rgb } from "../../src/art/accent";
import type { CoverResult } from "../../src/art/cover";
import {
	ADOPT_GUARD_MS,
	DialController,
	FLASH_MS,
	MODE_REVERT_MS,
	SKIP_COOLDOWN_MS,
	SKIP_TICKS,
	TAKEOVER_FADE_MS,
	TAKEOVER_MS,
	VOLUME_DEBOUNCE_MS,
	type ControllerDeps
} from "../../src/dial/controller";
import type { ConnStatus } from "../../src/ha/connection";
import { Feature, type PlayerState } from "../../src/ha/playerState";
import type { ResolvedDialSettings } from "../../src/settings";

const ENTITY = "media_player.living_room";
const CONNECTED: ConnStatus = { kind: "connected", haVersion: "2026.10.0" };
const SVG_PREFIX = "data:image/svg+xml,";
const VOLUME_FEATURES = Feature.VOLUME_SET | Feature.VOLUME_STEP;
const TRACK_FEATURES = Feature.NEXT_TRACK | Feature.PREVIOUS_TRACK;

const player = (over: Partial<PlayerState> = {}): PlayerState => ({
	entityId: ENTITY,
	status: "paused",
	friendlyName: "Living Room",
	title: "Short",
	artist: "Band",
	volume: 40,
	muted: false,
	features: VOLUME_FEATURES | TRACK_FEATURES,
	...over
});

const settings = (over: Partial<ResolvedDialSettings> = {}): ResolvedDialSettings => ({
	entityId: ENTITY,
	volumeStep: 2,
	labels: new Map(),
	tracksMode: true,
	...over
});

const cover = (key: string, accent: Rgb): CoverResult => {
	const data = new Uint8Array(4 * 4 * 4);
	for (let i = 0; i < data.length; i += 4) data.set([...accent, 255], i);
	return { key, image: { width: 4, height: 4, data }, accent };
};

type Setup = {
	p?: Partial<PlayerState> | null;
	s?: Partial<ResolvedDialSettings>;
	renderMode?: ControllerDeps["renderMode"];
	call?: ControllerDeps["call"];
};

/** A connected dial showing `p`, with time from vitest's fake clock. */
function setup(opts: Setup = {}) {
	const call = vi.fn<ControllerDeps["call"]>(opts.call ?? (async () => {}));
	const alert = vi.fn();
	const c = new DialController({ now: () => Date.now(), call, alert, renderMode: opts.renderMode }, settings(opts.s));
	c.setConnStatus(CONNECTED);
	c.setPlayer(opts.p === null ? null : player(opts.p));
	/** Moves the clock and ticks the controller every 10 ms, like a frame loop would. */
	const advance = (ms: number) => {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			vi.setSystemTime(Math.min(end, Date.now() + 10));
			c.tick(Date.now());
		}
	};
	const services = () => call.mock.calls.map(([service]) => service);
	return { c, call, alert, advance, services };
}

const fgSvg = (payload: Record<string, string> | null) => {
	expect(payload?.fg.startsWith(SVG_PREFIX)).toBe(true);
	return decodeURIComponent(payload!.fg.slice(SVG_PREFIX.length));
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000_000);
});

afterEach(() => {
	// The controller never schedules timers of its own: all time arrives through tick().
	expect(vi.getTimerCount()).toBe(0);
	vi.useRealTimers();
});

describe("timing constants (spec 6)", () => {
	it("match the spec", () => {
		expect([VOLUME_DEBOUNCE_MS, ADOPT_GUARD_MS, TAKEOVER_MS, TAKEOVER_FADE_MS]).toEqual([150, 2500, 1500, 300]);
		expect([SKIP_TICKS, SKIP_COOLDOWN_MS, MODE_REVERT_MS, FLASH_MS]).toEqual([4, 600, 6000, 350]);
	});
});

describe("volume mode", () => {
	it("echoes locally and sends one volume_set 150 ms after the last detent", () => {
		const { c, call, advance } = setup();
		c.rotate(3);
		expect(c.ui.volume).toBe(46);
		expect(c.ui.takeoverAlpha).toBe(1);
		expect(call).not.toHaveBeenCalled();
		advance(149);
		expect(call).not.toHaveBeenCalled();
		advance(1);
		expect(call.mock.calls).toEqual([["volume_set", { volume_level: 0.46 }]]);
		advance(1000);
		expect(call).toHaveBeenCalledTimes(1);
	});

	it("restarts the debounce window on each detent", () => {
		const { c, call, advance } = setup();
		c.rotate(1);
		advance(100);
		c.rotate(1);
		advance(149);
		expect(call).not.toHaveBeenCalled();
		advance(1);
		expect(call.mock.calls).toEqual([["volume_set", { volume_level: 0.44 }]]);
	});

	it("clamps to 0..100", () => {
		const { c } = setup();
		c.rotate(-100);
		expect(c.ui.volume).toBe(0);
		c.rotate(100);
		expect(c.ui.volume).toBe(100);
	});

	it("turning up while muted clears mute locally, with no mute service call", () => {
		const { c, services, advance } = setup({ p: { muted: true } });
		expect(c.ui.muted).toBe(true);
		c.rotate(1);
		expect(c.ui.muted).toBe(false);
		advance(200);
		expect(services()).toEqual(["volume_set"]);
	});

	it("turning down while muted keeps mute", () => {
		const { c } = setup({ p: { muted: true } });
		c.rotate(-1);
		expect(c.ui.muted).toBe(true);
	});

	it("ignores HA-reported volume for 2500 ms after local input, then adopts it", () => {
		const { c, advance } = setup();
		c.rotate(3);
		advance(1000);
		c.setPlayer(player({ volume: 30, muted: true }));
		expect(c.ui.volume).toBe(46);
		expect(c.ui.muted).toBe(false);
		advance(ADOPT_GUARD_MS - 1000 - 1);
		expect(c.ui.volume).toBe(46);
		advance(1);
		expect(c.ui.volume).toBe(30);
		expect(c.ui.muted).toBe(true);
	});

	it("adopts reports immediately when there was no local input", () => {
		const { c } = setup();
		c.setPlayer(player({ volume: 30 }));
		expect(c.ui.volume).toBe(30);
	});

	it("with VOLUME_STEP but not VOLUME_SET, calls volume_up/down per detent and shows a bar only", () => {
		const { c, call, services, advance } = setup({ p: { features: Feature.VOLUME_STEP } });
		expect(c.ui.volumeDisplay).toBe("bar-only");
		c.rotate(2);
		expect(services()).toEqual(["volume_up", "volume_up"]);
		expect(c.ui.volume).toBe(44);
		c.rotate(-3);
		expect(services()).toEqual(["volume_up", "volume_up", "volume_down", "volume_down", "volume_down"]);
		advance(1000);
		expect(services()).not.toContain("volume_set");
		expect(call).toHaveBeenCalledTimes(5);
	});

	it("with no volume control starts in tracks mode with the volume row hidden", () => {
		const { c } = setup({ p: { features: TRACK_FEATURES } });
		expect(c.ui.mode).toBe("tracks");
		expect(c.ui.volumeDisplay).toBe("hidden");
		c.press();
		expect(c.ui.mode).toBe("tracks");
	});

	it("with no volume control and no tracks, ignores rotation without an alert", () => {
		const { c, call, alert, advance } = setup({ p: { features: 0 } });
		expect(c.ui.mode).toBe("volume");
		c.rotate(3);
		advance(500);
		expect(call).not.toHaveBeenCalled();
		expect(alert).not.toHaveBeenCalled();
	});
});

describe("tracks mode", () => {
	it("skips every 4 detents, flashes for 350 ms and cools down for 600 ms", () => {
		const { c, services, advance } = setup();
		c.press();
		expect(c.ui.mode).toBe("tracks");
		c.rotate(1);
		c.rotate(1);
		c.rotate(1);
		expect(services()).toEqual([]);
		c.rotate(1);
		expect(services()).toEqual(["media_next_track"]);
		expect(c.ui.flashDir).toBe(1);
		advance(FLASH_MS - 10);
		expect(c.ui.flashDir).toBe(1);
		c.rotate(4);
		c.rotate(-4);
		expect(services()).toEqual(["media_next_track"]);
		advance(10);
		expect(c.ui.flashDir).toBe(0);
		advance(SKIP_COOLDOWN_MS - FLASH_MS);
		c.rotate(-4);
		expect(services()).toEqual(["media_next_track", "media_previous_track"]);
		expect(c.ui.flashDir).toBe(-1);
	});

	it("a change of direction resets the count", () => {
		const { c, services } = setup();
		c.press();
		c.rotate(3);
		c.rotate(-1);
		c.rotate(1);
		expect(services()).toEqual([]);
		c.rotate(3);
		expect(services()).toEqual(["media_next_track"]);
	});

	it("does not call a direction the entity lacks", () => {
		const { c, services, advance } = setup({ p: { features: VOLUME_FEATURES | Feature.NEXT_TRACK } });
		c.press();
		c.rotate(-4);
		expect(services()).toEqual([]);
		expect(c.ui.flashDir).toBe(0);
		advance(100);
		c.rotate(4);
		expect(services()).toEqual(["media_next_track"]);
	});

	it("reverts to volume mode after 6 s idle", () => {
		const { c, advance } = setup();
		c.press();
		advance(3000);
		c.rotate(1);
		advance(MODE_REVERT_MS - 10);
		expect(c.ui.mode).toBe("tracks");
		advance(10);
		expect(c.ui.mode).toBe("volume");
	});

	it("press toggles back to volume", () => {
		const { c } = setup();
		c.press();
		c.press();
		expect(c.ui.mode).toBe("volume");
	});

	it.each([
		["tracksMode off", { s: { tracksMode: false } }],
		["no track features", { p: { features: VOLUME_FEATURES } }]
	] as const)("press stays in volume mode with %s", (_name, opts: Setup) => {
		const { c, alert } = setup(opts);
		c.press();
		expect(c.ui.mode).toBe("volume");
		expect(alert).not.toHaveBeenCalled();
	});
});

describe("tap", () => {
	it("sends media_play_pause", () => {
		const { c, services } = setup();
		c.tap();
		expect(services()).toEqual(["media_play_pause"]);
	});

	it("still sends media_play_pause when the player is off, while rotate and press are ignored silently", () => {
		const { c, services, alert, advance } = setup({ p: { status: "off", title: undefined, artist: undefined } });
		c.rotate(3);
		c.press();
		advance(500);
		expect(c.ui.mode).toBe("volume");
		expect(c.ui.volume).toBe(40);
		expect(services()).toEqual([]);
		c.tap();
		expect(services()).toEqual(["media_play_pause"]);
		expect(alert).not.toHaveBeenCalled();
	});
});

describe("states (spec 7)", () => {
	it("not configured shows the setup message", () => {
		const { c } = setup();
		c.setConnStatus(null);
		expect(c.ui.message).toEqual({ headline: "Set up Spindle in Stream Deck" });
		expect(fgSvg(c.frame(Date.now()))).toContain("Set up Spindle");
	});

	it("stopped, or no entity in settings, is treated as not configured", () => {
		const a = setup();
		a.c.setConnStatus({ kind: "stopped" });
		expect(a.c.ui.message?.headline).toBe("Set up Spindle in Stream Deck");
		const b = setup({ s: { entityId: null } });
		expect(b.c.ui.message?.headline).toBe("Set up Spindle in Stream Deck");
	});

	it("auth_invalid shows Check token", () => {
		const { c } = setup();
		c.setConnStatus({ kind: "auth_invalid" });
		expect(c.ui.message).toEqual({ headline: "Check token" });
		expect(fgSvg(c.frame(Date.now()))).toContain("Check token");
	});

	it("connecting before the first connection shows Connecting…", () => {
		const call = vi.fn(async () => {});
		const c = new DialController({ now: () => Date.now(), call, alert: () => {} }, settings());
		c.setConnStatus({ kind: "connecting" });
		expect(c.ui.message).toEqual({ headline: "Connecting…" });
		expect(c.ui.dimmed).toBe(false);
	});

	it.each<ConnStatus>([{ kind: "unreachable", detail: "timeout" }, { kind: "connecting" }])(
		"$kind after a connection dims the last player view with a Reconnecting… badge",
		(status) => {
			const { c } = setup();
			c.setConnStatus(status);
			expect(c.ui.message).toBeUndefined();
			expect(c.ui.dimmed).toBe(true);
			expect(c.ui.badge).toBe("Reconnecting…");
			const svg = fgSvg(c.frame(Date.now()));
			expect(svg).toContain("Short");
			expect(svg).toContain("Reconnecting…");
		}
	);

	it("a missing entity shows Player not found with the entity id", () => {
		const { c } = setup({ p: null });
		expect(c.ui.message).toEqual({ headline: "Player not found", sub: ENTITY });
		// The headline wraps onto two lines (ruling R13), and so does the entity id.
		const svg = fgSvg(c.frame(Date.now()));
		expect(svg).toContain(">Player not<");
		expect(svg).toContain(">found<");
		expect(svg).toContain(">living_room<");
	});

	it.each(["unavailable", "unknown"])("%s dims the view and says Unavailable", (status) => {
		const { c } = setup({ p: { status, title: undefined, artist: undefined } });
		expect(c.ui.dimmed).toBe(true);
		expect(c.ui.message).toBeUndefined();
		const svg = fgSvg(c.frame(Date.now()));
		expect(svg).toContain("Living Room");
		expect(svg).toContain("Unavailable");
	});

	it("off shows the friendly name and Off", () => {
		const { c } = setup({ p: { status: "off", title: undefined, artist: undefined } });
		expect(c.ui.dimmed).toBe(false);
		const svg = fgSvg(c.frame(Date.now()));
		expect(svg).toContain("Living Room");
		expect(svg).toContain(">Off<");
	});

	it.each(["idle", "on", "standby"])("%s with no title shows the friendly name and Idle", (status) => {
		const { c } = setup({ p: { status, title: undefined, artist: undefined } });
		const svg = fgSvg(c.frame(Date.now()));
		expect(svg).toContain("Living Room");
		expect(svg).toContain(">Idle<");
	});

	it("buffering sets ui.buffering", () => {
		const { c } = setup({ p: { status: "buffering" } });
		expect(c.ui.buffering).toBe(true);
	});

	it("maps the source label through the settings", () => {
		const { c } = setup({ p: { source: "Spotify Connect" }, s: { labels: new Map([["spotify connect", "Spotify"]]) } });
		expect(c.ui.sourceLabel).toBe("Spotify");
	});
});

describe("input in error states", () => {
	const errorStates: [string, (c: DialController) => void][] = [
		["not configured", (c) => c.setConnStatus(null)],
		["auth_invalid", (c) => c.setConnStatus({ kind: "auth_invalid" })],
		["unreachable", (c) => c.setConnStatus({ kind: "unreachable", detail: "x" })],
		["player missing", (c) => c.setPlayer(null)],
		["unavailable", (c) => c.setPlayer(player({ status: "unavailable" }))]
	];

	it.each(errorStates)("%s: rotate, press and tap alert and call nothing (Review Focus 3)", (_name, enter) => {
		const { c, call, alert, advance } = setup();
		enter(c);
		c.rotate(1);
		c.press();
		c.tap();
		advance(1000);
		expect(alert).toHaveBeenCalledTimes(3);
		expect(call).not.toHaveBeenCalled();
		expect(c.ui.mode).toBe("volume");
	});

	it("turning while unreachable queues nothing for after the reconnect (Review Focus 4)", () => {
		const { c, call, alert, advance } = setup();
		c.setConnStatus({ kind: "unreachable", detail: "x" });
		for (let i = 0; i < 10; i++) c.rotate(1);
		expect(alert).toHaveBeenCalledTimes(10);
		expect(c.ui.volume).toBe(40);
		c.setConnStatus(CONNECTED);
		advance(1000);
		expect(call).not.toHaveBeenCalled();
	});

	it("a pending volume_set is cancelled when the connection drops (Review Focus 4)", () => {
		const { c, call, advance } = setup();
		c.rotate(2);
		advance(100);
		c.setConnStatus({ kind: "connecting" });
		advance(100);
		c.setConnStatus(CONNECTED);
		advance(1000);
		expect(call).not.toHaveBeenCalled();
	});

	it("a dropped connection clears the skip count", () => {
		const { c, services } = setup();
		c.press();
		c.rotate(3);
		c.setConnStatus({ kind: "connecting" });
		c.setConnStatus(CONNECTED);
		c.rotate(1);
		expect(services()).toEqual([]);
	});
});

describe("call failure", () => {
	it("a rejected call fires alert", async () => {
		const { c, alert } = setup({ call: () => Promise.reject(new Error("boom")) });
		c.tap();
		await vi.advanceTimersByTimeAsync(0);
		expect(alert).toHaveBeenCalledTimes(1);
	});

	it("a call that throws synchronously fires alert", () => {
		const { c, alert } = setup({
			call: () => {
				throw new Error("boom");
			}
		});
		c.tap();
		expect(alert).toHaveBeenCalledTimes(1);
	});
});

describe("frames and priority", () => {
	it("the first frame is urgent, full and carries bg; a paused fitting dial then goes static", () => {
		const { c } = setup();
		const t = Date.now();
		expect(c.urgent()).toBe(true);
		expect(c.priority(t)).toBe("full");
		const first = c.frame(t);
		expect(first?.bg).toMatch(/^data:image\/png;base64,/);
		expect(c.urgent()).toBe(false);
		expect(c.priority(t + 100)).toBe("none");
		expect(c.frame(t + 100)).toBeNull();
	});

	it("a change makes a static dial resend once without bg", () => {
		const { c } = setup();
		c.frame(Date.now());
		c.setPlayer(player({ title: "Other" }));
		expect(c.priority(Date.now())).toBe("full");
		expect(c.urgent()).toBe(false);
		const next = c.frame(Date.now());
		expect(Object.keys(next ?? {})).toEqual(["fg"]);
		expect(fgSvg(next)).toContain("Other");
		expect(c.priority(Date.now())).toBe("none");
	});

	it("playing (bars only) is half rate", () => {
		const { c } = setup({ p: { status: "playing" } });
		c.frame(Date.now());
		expect(c.priority(Date.now())).toBe("half");
	});

	it("scrolling text is full rate, and offset advances 2.4 px per full frame and 4.8 px per half frame", () => {
		const { c } = setup({ p: { title: "An Extremely Long Song Title That Cannot Possibly Fit" } });
		c.frame(Date.now());
		expect(c.priority(Date.now())).toBe("full");
		expect(c.ui.offset).toBeCloseTo(2.4);
		c.frame(Date.now());
		expect(c.ui.offset).toBeCloseTo(4.8);
		c.setPlayer(player({ status: "playing", title: "Short" }));
		expect(c.ui.offset).toBe(0);
		c.frame(Date.now()); // dirty: full
		c.frame(Date.now()); // bars only: half
		expect(c.ui.offset).toBeCloseTo(2.4 + 4.8);
	});

	it("the takeover is full rate until 1800 ms after the last rotate, then sends one final frame", () => {
		const { c, advance } = setup();
		c.frame(Date.now());
		c.rotate(1);
		const start = Date.now();
		c.frame(Date.now());
		advance(TAKEOVER_MS);
		expect(c.ui.takeoverAlpha).toBe(1);
		advance(TAKEOVER_FADE_MS / 2);
		expect(c.ui.takeoverAlpha).toBeCloseTo(0.5);
		c.frame(Date.now());
		advance(TAKEOVER_FADE_MS / 2 - 10);
		c.frame(Date.now());
		expect(c.priority(Date.now())).toBe("full");
		expect(Date.now() - start).toBe(1790);
		advance(10);
		expect(c.ui.takeoverAlpha).toBe(0);
		expect(c.frame(Date.now())).not.toBeNull();
		expect(c.priority(Date.now())).toBe("none");
	});

	it("a flash keeps the dial at full rate until it expires", () => {
		const { c, advance } = setup();
		c.press();
		c.frame(Date.now());
		c.rotate(4);
		c.frame(Date.now());
		expect(c.priority(Date.now())).toBe("full");
		advance(FLASH_MS);
		c.frame(Date.now());
		expect(c.priority(Date.now())).toBe("none");
	});

	it("a changed cover sends bg once, then omits it", () => {
		const { c } = setup();
		const first = c.frame(Date.now());
		c.setCover(cover("a", [200, 40, 40]));
		expect(c.urgent()).toBe(true);
		const next = c.frame(Date.now());
		expect(next?.bg).toMatch(/^data:image\/png;base64,/);
		expect(next?.bg).not.toBe(first?.bg);
		expect(fgSvg(next)).toContain("rgb(200,40,40)");
		c.setPlayer(player({ title: "Other" }));
		expect(c.frame(Date.now())?.bg).toBeUndefined();
		c.setCover(cover("a", [200, 40, 40]));
		expect(c.urgent()).toBe(false);
		c.setCover(null);
		expect(c.frame(Date.now())?.bg).toBe(first?.bg);
	});

	it("single mode sends only fg, with the backdrop embedded", () => {
		const { c } = setup({ renderMode: "single" });
		c.setCover(cover("a", [200, 40, 40]));
		const payload = c.frame(Date.now());
		expect(Object.keys(payload ?? {})).toEqual(["fg"]);
		const svg = fgSvg(payload);
		expect(svg).toMatch(/<image href="data:image\/png;base64,[^"]+"/);
		expect(svg).toContain("Short");
	});
});
