import type { CoverResult } from "../../src/art/cover";
import { bindDial, COVER_RETRIES, COVER_RETRY_MS, mediaPlayerItems, statusLine, type BindArgs } from "../../src/dial/binding";
import type { ConnStatus } from "../../src/ha/connection";
import { toPlayerState, type RawEntity } from "../../src/ha/playerState";

const ENTITY = "media_player.living_room";
const CONNECTED: ConnStatus = { kind: "connected", haVersion: "2026.10.0" };

function fakeConn(initial: ConnStatus = { kind: "connecting" }) {
	const statusCbs = new Set<(s: ConnStatus) => void>();
	const entityCbs = new Set<(raw: RawEntity | null) => void>();
	const subscribed: string[] = [];
	return {
		status: initial,
		statusCbs,
		entityCbs,
		subscribed,
		onStatus(cb: (s: ConnStatus) => void) {
			statusCbs.add(cb);
			return () => statusCbs.delete(cb);
		},
		subscribeEntity(id: string, cb: (raw: RawEntity | null) => void) {
			subscribed.push(id);
			entityCbs.add(cb);
			return () => entityCbs.delete(cb);
		},
		callService: vi.fn(async () => {}),
		emitStatus(s: ConnStatus) {
			this.status = s;
			for (const cb of [...statusCbs]) cb(s);
		},
		emitEntity(raw: RawEntity | null) {
			for (const cb of [...entityCbs]) cb(raw);
		}
	};
}

type Deferred = { url: string; resolve: (c: CoverResult) => void; reject: (e: Error) => void };

function fakeCovers() {
	const calls: Deferred[] = [];
	return {
		calls,
		load: vi.fn((url: string) => new Promise<CoverResult>((resolve, reject) => calls.push({ url, resolve, reject })))
	};
}

function fakeSchedule() {
	const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
	const schedule = (fn: () => void, ms: number) => {
		const t = { fn, ms, cancelled: false };
		timers.push(t);
		return () => {
			t.cancelled = true;
		};
	};
	/** Runs every live timer once (in order) and forgets it. */
	const runAll = () => {
		const due = timers.splice(0);
		for (const t of due) if (!t.cancelled) t.fn();
	};
	return { timers, schedule, runAll, live: () => timers.filter((t) => !t.cancelled) };
}

const fakeCtl = () => ({ setConnStatus: vi.fn(), setPlayer: vi.fn(), setCover: vi.fn() });

const raw = (pictureUrl?: string, over: Record<string, unknown> = {}): RawEntity => ({
	state: "playing",
	attributes: { friendly_name: "Living Room", media_title: "Song", ...(pictureUrl ? { entity_picture: pictureUrl } : {}), ...over }
});

const coverFor = (key: string): CoverResult => ({ key, image: { width: 1, height: 1, data: new Uint8Array(4) }, accent: [1, 2, 3] });

const flush = () => new Promise<void>((r) => setImmediate(r));

function setup(initial?: ConnStatus) {
	const conn = fakeConn(initial);
	const covers = fakeCovers();
	const ctl = fakeCtl();
	const sched = fakeSchedule();
	const args: BindArgs = { conn, covers, ctl, entityId: ENTITY, now: () => 0, schedule: sched.schedule };
	const unbind = bindDial(args);
	return { conn, covers, ctl, sched, unbind };
}

describe("bindDial", () => {
	it("forwards the current status on bind and every later status change", () => {
		const { conn, ctl } = setup({ kind: "connecting" });
		expect(ctl.setConnStatus).toHaveBeenNthCalledWith(1, { kind: "connecting" });
		conn.emitStatus(CONNECTED);
		conn.emitStatus({ kind: "unreachable", detail: "closed (1006)" });
		expect(ctl.setConnStatus).toHaveBeenNthCalledWith(2, CONNECTED);
		expect(ctl.setConnStatus).toHaveBeenNthCalledWith(3, { kind: "unreachable", detail: "closed (1006)" });
	});

	it("subscribes to the entity and turns raw updates into PlayerState, null into null", () => {
		const { conn, ctl } = setup(CONNECTED);
		expect(conn.subscribed).toEqual([ENTITY]);
		const r = raw();
		conn.emitEntity(r);
		expect(ctl.setPlayer).toHaveBeenLastCalledWith(toPlayerState(ENTITY, r));
		conn.emitEntity(null);
		expect(ctl.setPlayer).toHaveBeenLastCalledWith(null);
	});

	it("loads a new picture once and hands the result to setCover", async () => {
		const { conn, covers, ctl } = setup(CONNECTED);
		conn.emitEntity(raw("/api/media_player_proxy/a"));
		expect(covers.load).toHaveBeenCalledTimes(1);
		expect(covers.load).toHaveBeenCalledWith("/api/media_player_proxy/a");
		const c = coverFor("/api/media_player_proxy/a");
		covers.calls[0].resolve(c);
		await flush();
		expect(ctl.setCover).toHaveBeenCalledWith(c);
	});

	it("does not reload when the picture is unchanged across updates", async () => {
		const { conn, covers } = setup(CONNECTED);
		conn.emitEntity(raw("/pic/a", { volume_level: 0.2 }));
		covers.calls[0].resolve(coverFor("/pic/a"));
		await flush();
		conn.emitEntity(raw("/pic/a", { volume_level: 0.3 }));
		conn.emitEntity(raw("/pic/a", { media_title: "Other" }));
		expect(covers.load).toHaveBeenCalledTimes(1);
	});

	it("clears the cover without loading when the picture goes away", () => {
		const { conn, covers, ctl } = setup(CONNECTED);
		conn.emitEntity({ state: "off", attributes: { friendly_name: "Living Room" } });
		expect(covers.load).not.toHaveBeenCalled();
		expect(ctl.setCover).toHaveBeenCalledWith(null);
	});

	it("retries a failed load after 5 s, at most 3 times", async () => {
		const { conn, covers, ctl, sched } = setup(CONNECTED);
		conn.emitEntity(raw("/pic/a"));
		for (let attempt = 0; attempt <= COVER_RETRIES; attempt++) {
			expect(covers.load).toHaveBeenCalledTimes(attempt + 1);
			covers.calls[attempt].reject(new Error("HTTP 500"));
			await flush();
			expect(ctl.setCover).toHaveBeenLastCalledWith(null);
			if (attempt < COVER_RETRIES) {
				expect(sched.live()).toHaveLength(1);
				expect(sched.live()[0].ms).toBe(COVER_RETRY_MS);
				sched.runAll();
			}
		}
		expect(COVER_RETRY_MS).toBe(5000);
		expect(COVER_RETRIES).toBe(3);
		expect(sched.live()).toHaveLength(0);
		expect(covers.load).toHaveBeenCalledTimes(4);
	});

	it("resets the retry count when the picture changes", async () => {
		const { conn, covers, sched } = setup(CONNECTED);
		conn.emitEntity(raw("/pic/a"));
		for (let i = 0; i <= COVER_RETRIES; i++) {
			covers.calls[i].reject(new Error("HTTP 500"));
			await flush();
			sched.runAll();
		}
		expect(covers.load).toHaveBeenCalledTimes(4);
		conn.emitEntity(raw("/pic/b"));
		expect(covers.load).toHaveBeenCalledTimes(5);
		covers.calls[4].reject(new Error("HTTP 500"));
		await flush();
		expect(sched.live()).toHaveLength(1);
		sched.runAll();
		expect(covers.load).toHaveBeenLastCalledWith("/pic/b");
		expect(covers.load).toHaveBeenCalledTimes(6);
	});

	it("cancels a pending retry when the picture changes", async () => {
		const { conn, covers, sched } = setup(CONNECTED);
		conn.emitEntity(raw("/pic/a"));
		covers.calls[0].reject(new Error("HTTP 500"));
		await flush();
		expect(sched.live()).toHaveLength(1);
		conn.emitEntity(raw("/pic/b"));
		expect(sched.live()).toHaveLength(0);
		expect(covers.load).toHaveBeenCalledTimes(2);
	});

	it("discards a stale result for a picture that has since changed", async () => {
		const { conn, covers, ctl, sched } = setup(CONNECTED);
		conn.emitEntity(raw("/pic/a"));
		conn.emitEntity(raw("/pic/b"));
		const b = coverFor("/pic/b");
		covers.calls[1].resolve(b);
		await flush();
		covers.calls[0].resolve(coverFor("/pic/a"));
		await flush();
		expect(ctl.setCover).toHaveBeenCalledTimes(1);
		expect(ctl.setCover).toHaveBeenLastCalledWith(b);

		// A late failure for the old picture neither clears the cover nor schedules a retry.
		conn.emitEntity(raw("/pic/c"));
		conn.emitEntity(raw("/pic/d"));
		covers.calls[2].reject(new Error("HTTP 500"));
		await flush();
		expect(ctl.setCover).toHaveBeenCalledTimes(1);
		expect(sched.live()).toHaveLength(0);
	});

	it("unbind unsubscribes, cancels a pending retry and ignores late results", async () => {
		const { conn, covers, ctl, sched, unbind } = setup(CONNECTED);
		conn.emitEntity(raw("/pic/a"));
		covers.calls[0].reject(new Error("HTTP 500"));
		await flush();
		conn.emitEntity(raw("/pic/b"));
		expect(sched.live()).toHaveLength(0);
		covers.calls[1].reject(new Error("HTTP 500"));
		await flush();
		expect(sched.live()).toHaveLength(1);
		ctl.setCover.mockClear();

		unbind();
		expect(conn.statusCbs.size).toBe(0);
		expect(conn.entityCbs.size).toBe(0);
		expect(sched.live()).toHaveLength(0);
		conn.emitStatus({ kind: "connecting" });
		expect(ctl.setConnStatus).toHaveBeenCalledTimes(1);
	});

	it("unbind drops a load still in flight", async () => {
		const { conn, covers, ctl, unbind } = setup(CONNECTED);
		conn.emitEntity(raw("/pic/a"));
		unbind();
		covers.calls[0].resolve(coverFor("/pic/a"));
		await flush();
		expect(ctl.setCover).not.toHaveBeenCalled();
	});
});

describe("mediaPlayerItems", () => {
	const state = (entity_id: string, friendly_name?: string) => ({
		entity_id,
		attributes: friendly_name === undefined ? {} : { friendly_name }
	});

	it("keeps media players only, labels them 'Friendly (entity_id)' and sorts case-insensitively", () => {
		const items = mediaPlayerItems([
			state("light.kitchen", "Kitchen"),
			state("media_player.living_room", "living Room"),
			state("media_player.den", "Den"),
			state("sensor.media_player_count", "Players"),
			state("media_player.attic")
		]);
		expect(items).toEqual([
			{ value: "media_player.den", label: "Den (media_player.den)" },
			{ value: "media_player.living_room", label: "living Room (media_player.living_room)" },
			{ value: "media_player.attic", label: "media_player.attic (media_player.attic)" }
		]);
	});

	it("appends the current entity as (not found) when HA no longer has it", () => {
		const items = mediaPlayerItems([state("media_player.den", "Den")], "media_player.gone");
		expect(items).toEqual([
			{ value: "media_player.den", label: "Den (media_player.den)" },
			{ value: "media_player.gone", label: "(not found) media_player.gone" }
		]);
	});

	it("does not mark a present current entity", () => {
		const items = mediaPlayerItems([state("media_player.den", "Den")], "media_player.den");
		expect(items).toEqual([{ value: "media_player.den", label: "Den (media_player.den)" }]);
	});
});

describe("statusLine", () => {
	const HOST = "homeassistant.local:8123";

	it("asks for setup when there is no usable URL or token", () => {
		expect(statusLine(null, HOST, undefined)).toBe("Enter your Home Assistant URL and token");
	});

	it("reports the version and player count once connected", () => {
		expect(statusLine(CONNECTED, HOST, 3)).toBe("Connected · HA 2026.10.0 · 3 media players");
		expect(statusLine(CONNECTED, HOST, 1)).toBe("Connected · HA 2026.10.0 · 1 media players");
	});

	it("says Connecting… while connected but the count is still unknown", () => {
		expect(statusLine(CONNECTED, HOST, undefined)).toBe("Connecting…");
	});

	it("maps auth_invalid, unreachable and the rest", () => {
		expect(statusLine({ kind: "auth_invalid" }, HOST, undefined)).toBe("Token rejected");
		expect(statusLine({ kind: "unreachable", detail: "error" }, HOST, undefined)).toBe("Can't reach homeassistant.local:8123");
		expect(statusLine({ kind: "connecting" }, HOST, undefined)).toBe("Connecting…");
		expect(statusLine({ kind: "stopped" }, HOST, undefined)).toBe("Connecting…");
	});
});
