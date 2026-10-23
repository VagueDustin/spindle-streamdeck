import type { ConnStatus } from "../../src/ha/connection";
import { Feature, type PlayerState } from "../../src/ha/playerState";
import { ADOPT_GUARD_MS, PlayerSession, type SessionDeps } from "../../src/player/session";

const CONNECTED: ConnStatus = { kind: "connected", haVersion: "2026.10.0" };
const player = (over: Partial<PlayerState> = {}): PlayerState => ({
	entityId: "media_player.den",
	status: "playing",
	friendlyName: "Den",
	title: "Song",
	artist: "Band",
	volume: 40,
	muted: false,
	features: Feature.VOLUME_SET | Feature.VOLUME_MUTE | Feature.NEXT_TRACK,
	...over
});

function setup(p: Partial<PlayerState> = {}) {
	let now = 1_000_000;
	const call = vi.fn<SessionDeps["call"]>(async () => {});
	const alert = vi.fn();
	const s = new PlayerSession({ now: () => now, call, alert }, { entityId: "media_player.den", volumeStep: 5, labels: new Map() });
	s.setConnStatus(CONNECTED);
	s.setPlayer(player(p));
	return { s, call, alert, at: (t: number) => (now = t), now: () => now };
}

describe("PlayerSession", () => {
	it("toggles mute locally and in HA, and ignores HA's stale mute during the guard", () => {
		const { s, call, now } = setup();
		expect(s.toggleMute(now())).toBe(true);
		expect(s.muted).toBe(true);
		expect(call).toHaveBeenCalledWith("volume_mute", { is_volume_muted: true });
		s.setPlayer(player({ muted: false }));
		expect(s.muted).toBe(true);
	});

	it("adopts HA's mute once the guard has passed", () => {
		const { s, now, at } = setup();
		s.toggleMute(now());
		at(now() + ADOPT_GUARD_MS);
		s.tick(now());
		s.setPlayer(player({ muted: false }));
		expect(s.muted).toBe(false);
	});

	it("alerts instead of muting a player without mute", () => {
		const { s, call, alert, now } = setup({ features: Feature.VOLUME_SET });
		expect(s.toggleMute(now())).toBe(false);
		expect(alert).toHaveBeenCalledTimes(1);
		expect(call).not.toHaveBeenCalled();
	});

	it("steps the volume by the volume step and reports players with no volume control", () => {
		const { s, now } = setup();
		expect(s.stepVolume(-1, now())).toBe(true);
		expect(s.volume).toBe(35);
		const none = setup({ features: 0 });
		expect(none.s.stepVolume(1, none.now())).toBe(false);
	});

	it("bumps rev on every visible change and coverRev only for a new cover", () => {
		const { s } = setup();
		const rev = s.rev;
		s.setPlayer(player({ title: "Other" }));
		expect(s.rev).toBeGreaterThan(rev);
		const image = { width: 1, height: 1, data: new Uint8Array(4) };
		s.setCover({ key: "a", image, accent: [1, 2, 3] });
		const coverRev = s.coverRev;
		s.setCover({ key: "a", image, accent: [1, 2, 3] });
		expect(s.coverRev).toBe(coverRev);
	});
});
