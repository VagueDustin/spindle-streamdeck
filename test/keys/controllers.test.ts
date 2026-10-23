import type { ControllerDeps } from "../../src/dial/controller";
import type { ConnStatus } from "../../src/ha/connection";
import { Feature, type PlayerState } from "../../src/ha/playerState";
import { CoverKeyController, HOLD_DELAY_MS, HOLD_REPEAT_MS, TransportKeyController } from "../../src/keys/controllers";
import { VOLUME_DEBOUNCE_MS } from "../../src/player/session";
import { resolveCoverKeySettings, resolveTransportKeySettings, type TransportFunction } from "../../src/settings";

const CONNECTED: ConnStatus = { kind: "connected", haVersion: "2026.10.0" };
const SVG_PREFIX = "data:image/svg+xml,";
const ENTITY = "media_player.den";

const player = (over: Partial<PlayerState> = {}): PlayerState => ({
	entityId: ENTITY,
	status: "playing",
	friendlyName: "Den",
	title: "Song",
	artist: "Band",
	volume: 40,
	muted: false,
	features: Feature.PLAY | Feature.PAUSE | Feature.VOLUME_SET | Feature.VOLUME_MUTE | Feature.NEXT_TRACK,
	...over
});

const image = (payload: Record<string, string> | null) => {
	expect(payload?.image.startsWith(SVG_PREFIX)).toBe(true);
	return decodeURIComponent(payload!.image.slice(SVG_PREFIX.length));
};

function deps() {
	let now = 1_000_000;
	const call = vi.fn<ControllerDeps["call"]>(async () => {});
	const alert = vi.fn();
	return { d: { now: () => now, call, alert }, call, alert, at: (t: number) => (now = t), now: () => now };
}

function transport(fn: TransportFunction, p: Partial<PlayerState> = {}) {
	const x = deps();
	const k = new TransportKeyController(x.d, resolveTransportKeySettings({ entityId: ENTITY, function: fn, volumeStep: 2 }));
	k.setConnStatus(CONNECTED);
	k.setPlayer(player(p));
	return { k, ...x };
}

describe("Transport key", () => {
	it.each([
		["playpause", "media_play_pause"],
		["next", "media_next_track"]
	] as const)("%s sends %s", (fn, service) => {
		const { k, call } = transport(fn);
		k.press();
		expect(call).toHaveBeenCalledWith(service, undefined);
	});

	it("mute toggles and the icon turns red", () => {
		const { k, call, now } = transport("mute");
		k.press();
		expect(call).toHaveBeenCalledWith("volume_mute", { is_volume_muted: true });
		expect(image(k.frame(now()))).toContain("rgb(255,110,110)");
	});

	it("volume up steps once, then repeats while held, and stops on release", () => {
		const { k, call, at, now } = transport("volume_up");
		k.press();
		at(now() + HOLD_DELAY_MS);
		k.tick(now());
		at(now() + HOLD_REPEAT_MS);
		k.tick(now());
		k.release();
		at(now() + HOLD_REPEAT_MS);
		k.tick(now());
		at(now() + VOLUME_DEBOUNCE_MS);
		k.tick(now());
		// The press, then two repeats (each repeat is past the debounce, so each sends): 42, 44, 46, then nothing after release.
		expect(call.mock.calls).toEqual([
			["volume_set", { volume_level: 0.42 }],
			["volume_set", { volume_level: 0.44 }],
			["volume_set", { volume_level: 0.46 }]
		]);
		expect(image(k.frame(now()))).toContain(">46<");
	});

	it("draws an unsupported function dimmed and alerts on press", () => {
		const { k, call, alert, now } = transport("previous");
		expect(image(k.frame(now()))).toContain('fill-opacity="0.3"');
		k.press();
		expect(call).not.toHaveBeenCalled();
		expect(alert).toHaveBeenCalledTimes(1);
	});

	it("dims play/pause and alerts for a player that can neither play nor pause", () => {
		const { k, call, alert, now } = transport("playpause", { features: Feature.VOLUME_SET });
		expect(image(k.frame(now()))).toContain('fill-opacity="0.3"');
		k.press();
		expect(call).not.toHaveBeenCalled();
		expect(alert).toHaveBeenCalledTimes(1);
	});

	it("still sends play/pause to a player that is off, to try to wake it", () => {
		const { k, call } = transport("playpause", { status: "off", features: 0 });
		k.press();
		expect(call).toHaveBeenCalledWith("media_play_pause", undefined);
	});

	it("shows play while paused and pause bars while playing", () => {
		const paused = transport("playpause", { status: "paused" });
		expect(image(paused.k.frame(paused.now()))).toContain("<path");
		const playing = transport("playpause");
		expect(image(playing.k.frame(playing.now()))).not.toContain("<path");
	});

	it("sends nothing when HA reports a change the key does not show", () => {
		const { k, now } = transport("next");
		k.frame(now());
		k.setPlayer(player({ title: "Another song" }));
		expect(k.priority()).toBe("full");
		expect(k.frame(now())).toBeNull();
		expect(k.priority()).toBe("none");
	});

	it("shows a short word instead of the player when it cannot be used", () => {
		const { k, now } = transport("next");
		k.setConnStatus({ kind: "auth_invalid" });
		expect(image(k.frame(now()))).toContain("Check token");
	});
});

describe("Cover key", () => {
	function cover(display: string, p: Partial<PlayerState> = {}) {
		const x = deps();
		const k = new CoverKeyController(x.d, resolveCoverKeySettings({ entityId: ENTITY, display }));
		k.setConnStatus(CONNECTED);
		k.setPlayer(player(p));
		return { k, ...x };
	}

	it("press plays or pauses", () => {
		const { k, call } = cover("art");
		k.press();
		expect(call).toHaveBeenCalledWith("media_play_pause", undefined);
	});

	it("embeds the cover art, fitted to the key", () => {
		const { k, now } = cover("art");
		const data = new Uint8Array(4 * 4 * 4).fill(200);
		k.setCover({ key: "a", image: { width: 4, height: 4, data }, accent: [200, 10, 10] });
		expect(image(k.frame(now()))).toContain('<image href="data:image/png;base64,');
	});

	it("shows the paused badge in art mode", () => {
		const { k, now } = cover("art", { status: "paused" });
		expect(image(k.frame(now()))).toContain("<circle");
	});

	it("cover art only draws no badge, playing or paused", () => {
		for (const status of ["playing", "paused"]) {
			const { k, now } = cover("art-plain", { status });
			const svg = image(k.frame(now()));
			expect(svg).not.toContain("<circle");
			expect(svg).not.toContain('fill-opacity="0.6"');
		}
	});

	it("text mode prints title and artist", () => {
		const { k, now } = cover("text");
		const svg = image(k.frame(now()));
		expect(svg).toContain(">Song<");
		expect(svg).toContain(">Band<");
	});

	it("art + title scrolls a long title at half rate", () => {
		const { k, now } = cover("art-title", { title: "A title much too long to fit on one small key at all" });
		k.frame(now());
		expect(k.priority()).toBe("half");
		expect(k.frame(now())).not.toBeNull();
	});

	it("defaults unknown display and function values", () => {
		expect(resolveCoverKeySettings({ display: "bogus" }).display).toBe("art");
		expect(resolveTransportKeySettings({ function: "bogus" }).fn).toBe("playpause");
	});
});
