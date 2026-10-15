import { getConnection, HaConnection, stopConnection, type ConnStatus, type HaConnectionOptions, type ScopedLogger } from "../../src/ha/connection";
import type { RawEntity } from "../../src/ha/playerState";
import { FakeHa, HA_VERSION } from "../helpers/fakeHa";

const TOKEN = "test-token-6f1d2a9c";
const LIVING = "media_player.living_room";
const KITCHEN = "media_player.kitchen";
const GHOST = "media_player.ghost";

const playing: RawEntity = { state: "playing", attributes: { media_title: "So What", volume_level: 0.42 } };
const idle: RawEntity = { state: "idle", attributes: { friendly_name: "Kitchen" } };

let fake: FakeHa;
let conns: HaConnection[] = [];
let constructed = 0;

/** The global WebSocket, counting constructions so "never reconnects" is checked client-side, without waiting. */
class CountingWebSocket extends WebSocket {
	constructor(...args: ConstructorParameters<typeof WebSocket>) {
		super(...args);
		constructed++;
	}
}

function connect(extra: Partial<HaConnectionOptions> = {}): HaConnection {
	const conn = new HaConnection({ wsUrl: fake.url, token: TOKEN, WebSocketImpl: CountingWebSocket, ...extra });
	conns.push(conn);
	conn.start();
	return conn;
}

/** Yields to real I/O (setImmediate is never faked here) until `pred` holds; the test timeout bounds it. */
async function until(pred: () => boolean): Promise<void> {
	while (!pred()) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

function record(conn: HaConnection, id: string) {
	const seen: Array<RawEntity | null> = [];
	const off = conn.subscribeEntity(id, (raw) => seen.push(raw));
	return { seen, off };
}

function useFakeClock() {
	vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
}

beforeEach(async () => {
	constructed = 0;
	fake = await FakeHa.start({ token: TOKEN, entities: { [LIVING]: playing, [KITCHEN]: idle } });
});

afterEach(async () => {
	for (const conn of conns) {
		conn.stop();
	}
	conns = [];
	vi.useRealTimers();
	vi.restoreAllMocks();
	await fake.close();
});

test("connects and reports haVersion", async () => {
	const statuses: ConnStatus[] = [];
	const conn = new HaConnection({ wsUrl: fake.url, token: TOKEN });
	conns.push(conn);
	conn.onStatus((s) => statuses.push(s));
	conn.start();
	await until(() => conn.status.kind === "connected");
	expect(statuses).toEqual([{ kind: "connecting" }, { kind: "connected", haVersion: HA_VERSION }]);
	expect(conn.status).toEqual({ kind: "connected", haVersion: HA_VERSION });
});

test("auth_invalid stops for good", async () => {
	useFakeClock();
	const conn = connect({ token: "wrong-token" });
	await until(() => conn.status.kind === "auth_invalid");
	await vi.advanceTimersByTimeAsync(3000);
	expect(constructed).toBe(1);
	expect(fake.connections).toBe(1);
	expect(conn.status).toEqual({ kind: "auth_invalid" });
	conn.start(); // already started: must not retry the same bad token
	expect(constructed).toBe(1);
});

test("reconnects with backoff after drop and re-subscribes", async () => {
	useFakeClock();
	const conn = connect();
	const { seen } = record(conn, LIVING);
	await until(() => seen.length === 1);
	expect(seen[0]).toEqual(playing);

	fake.dropAll();
	await until(() => conn.status.kind === "unreachable");
	await vi.advanceTimersByTimeAsync(799);
	expect(constructed).toBe(1);
	await vi.advanceTimersByTimeAsync(401);
	expect(constructed).toBe(2);

	await until(() => seen.length === 2);
	expect(fake.connections).toBe(2);
	expect(conn.status.kind).toBe("connected");
	expect(fake.sent("subscribe_entities").map((m) => m.entity_ids)).toEqual([[LIVING], [LIVING]]);
	expect(seen).toEqual([playing, playing]); // the fresh `a` snapshot, and no spurious null
});

test("backoff doubles per failure, caps at the max and resets after auth_ok", async () => {
	useFakeClock();
	vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter
	const conn = connect({ backoffMinMs: 100, backoffMaxMs: 400 });
	await until(() => conn.status.kind === "connected");
	fake.refuse(true);
	fake.dropAll();

	let expected = 1;
	for (const delay of [100, 200, 400, 400]) {
		await until(() => conn.status.kind === "unreachable");
		await vi.advanceTimersByTimeAsync(delay - 1);
		expect(constructed).toBe(expected);
		await vi.advanceTimersByTimeAsync(1);
		expect(constructed).toBe(++expected);
	}

	await until(() => conn.status.kind === "unreachable");
	fake.refuse(false);
	await vi.advanceTimersByTimeAsync(400);
	await until(() => conn.status.kind === "connected");
	fake.dropAll();
	await until(() => conn.status.kind === "unreachable");
	await vi.advanceTimersByTimeAsync(100);
	expect(constructed).toBe(expected + 2);
});

test("ping timeout forces reconnect", async () => {
	useFakeClock();
	const conn = connect({ pingIntervalMs: 30000, pongTimeoutMs: 10000 });
	await until(() => conn.status.kind === "connected");

	await vi.advanceTimersByTimeAsync(30000);
	await until(() => fake.sent("ping").length === 1);
	await conn.getStates(); // answered after the pong, so the pong has been handled
	await vi.advanceTimersByTimeAsync(10000);
	expect(conn.status.kind).toBe("connected");

	fake.silencePongs();
	await vi.advanceTimersByTimeAsync(20000); // second ping
	await until(() => fake.sent("ping").length === 2);
	await vi.advanceTimersByTimeAsync(9999);
	expect(conn.status.kind).toBe("connected");
	await vi.advanceTimersByTimeAsync(1);
	expect(conn.status).toEqual({ kind: "unreachable", detail: expect.stringContaining("pong") });
	await vi.advanceTimersByTimeAsync(1200);
	expect(constructed).toBe(2);
	await until(() => conn.status.kind === "connected" && fake.connections === 2);
});

test("missing entity yields null", async () => {
	const conn = connect();
	const { seen } = record(conn, GHOST);
	await until(() => seen.length === 1);
	expect(seen).toEqual([null]);

	// a later diff for another entity, or a re-subscribe, does not repeat it
	const living = record(conn, LIVING);
	await until(() => fake.sent("subscribe_entities").length === 2 && living.seen.length === 1);
	expect(seen).toEqual([null]);
	expect(living.seen).toEqual([playing]);
});

test("entity removed while subscribed yields null once", async () => {
	const conn = connect();
	const { seen } = record(conn, LIVING);
	await until(() => seen.length === 1);
	fake.pushEntities({ r: [LIVING] });
	await until(() => seen.length === 2);
	expect(seen).toEqual([playing, null]);
});

test("diffs reach only the changed entity's subscribers; bookkeeping-only diffs are silent", async () => {
	const conn = connect();
	const living = record(conn, LIVING);
	const kitchen = record(conn, KITCHEN);
	await until(() => living.seen.length === 1 && kitchen.seen.length === 1);

	fake.pushEntities({ c: { [LIVING]: { "+": { lu: 1 } } } });
	fake.pushEntities({ c: { [LIVING]: { "+": { s: "paused" } } } });
	await until(() => living.seen.length === 2);
	expect(living.seen[1]).toEqual({ ...playing, state: "paused" });
	expect(kitchen.seen).toEqual([idle]);
});

test("a late subscriber gets the current value without waiting for a diff", async () => {
	const conn = connect();
	const first = record(conn, LIVING);
	await until(() => first.seen.length === 1);
	const second = record(conn, LIVING);
	await until(() => second.seen.length === 1);
	expect(second.seen).toEqual([playing]);
	expect(first.seen).toEqual([playing]);
	expect(fake.sent("subscribe_entities")).toHaveLength(1);
});

test("two subscribers, one server subscription", async () => {
	const conn = connect();
	const a = record(conn, LIVING);
	const b = record(conn, LIVING);
	await until(() => a.seen.length === 1 && b.seen.length === 1);
	expect(fake.sent("subscribe_entities")).toHaveLength(1);
	const subId = fake.sent("subscribe_entities")[0].id;

	a.off();
	await Promise.resolve();
	b.off();
	await until(() => fake.sent("unsubscribe_events").length === 1);
	expect(fake.sent("unsubscribe_events")[0].subscription).toBe(subId);
	expect(fake.sent("subscribe_entities")).toHaveLength(1);
});

test("a changed set re-subscribes with the union and unsubscribes the old one", async () => {
	const conn = connect();
	const living = record(conn, LIVING);
	await until(() => living.seen.length === 1);
	const kitchen = record(conn, KITCHEN);
	await until(() => kitchen.seen.length === 1);
	const subs = fake.sent("subscribe_entities");
	expect(subs.map((m) => m.entity_ids)).toEqual([[LIVING], [LIVING, KITCHEN]]);
	await until(() => fake.sent("unsubscribe_events").length === 1);
	expect(fake.sent("unsubscribe_events")[0].subscription).toBe(subs[0].id);
});

test("falls back to state_changed", async () => {
	await fake.close();
	fake = await FakeHa.start({ token: TOKEN, entities: { [LIVING]: playing, [KITCHEN]: idle }, rejectSubscribeEntities: true });
	const conn = connect();
	const { seen } = record(conn, LIVING);
	const ghost = record(conn, GHOST);
	await until(() => seen.length === 1 && ghost.seen.length === 1);
	expect(seen).toEqual([playing]);
	expect(ghost.seen).toEqual([null]);
	expect(fake.sent("subscribe_events")).toEqual([expect.objectContaining({ event_type: "state_changed" })]);
	expect(fake.sent("get_states")).toHaveLength(1);

	const paused: RawEntity = { state: "paused", attributes: { media_title: "So What" } };
	fake.pushStateChanged(KITCHEN, { state: "off", attributes: {} });
	fake.pushStateChanged(LIVING, paused);
	await until(() => seen.length === 2);
	expect(seen[1]).toEqual(paused);

	fake.pushStateChanged(LIVING, null);
	await until(() => seen.length === 3);
	expect(seen[2]).toBeNull();
	expect(ghost.seen).toEqual([null]);
});

test("callService shape", async () => {
	const conn = connect();
	await until(() => conn.status.kind === "connected");
	await conn.callService("media_player", "volume_set", LIVING, { volume_level: 0.42 });
	expect(fake.serviceCalls).toHaveLength(1);
	const { id, ...payload } = fake.serviceCalls[0];
	expect(typeof id).toBe("number");
	expect(payload).toEqual({
		type: "call_service",
		domain: "media_player",
		service: "volume_set",
		target: { entity_id: LIVING },
		service_data: { volume_level: 0.42 }
	});
});

test("callService while disconnected rejects", async () => {
	const conn = new HaConnection({ wsUrl: fake.url, token: TOKEN });
	conns.push(conn);
	await expect(conn.callService("media_player", "media_play_pause", LIVING)).rejects.toThrow("not connected");
	conn.start();
	await expect(conn.callService("media_player", "media_play_pause", LIVING)).rejects.toThrow("not connected");
	await expect(conn.getStates()).rejects.toThrow("not connected");
	await until(() => conn.status.kind === "connected");
	fake.dropAll();
	await until(() => conn.status.kind === "unreachable");
	await expect(conn.callService("media_player", "media_play_pause", LIVING)).rejects.toThrow("not connected");
	expect(fake.serviceCalls).toHaveLength(0);
});

test("a failed call_service rejects with HA's error", async () => {
	await fake.close();
	fake = await FakeHa.start({ token: TOKEN, serviceError: { code: "service_validation_error", message: "Volume out of range" } });
	const conn = connect();
	await until(() => conn.status.kind === "connected");
	await expect(conn.callService("media_player", "volume_set", LIVING, { volume_level: 2 })).rejects.toThrow(
		/service_validation_error.*Volume out of range/
	);
});

test("pending requests reject when the socket closes and are not replayed", async () => {
	fake.holdReplies("call_service");
	const conn = connect();
	await until(() => conn.status.kind === "connected");
	const call = conn.callService("media_player", "volume_up", LIVING);
	await until(() => fake.sent("call_service").length === 1);
	fake.dropAll();
	await expect(call).rejects.toThrow("connection closed");
});

test("getStates returns HA's states", async () => {
	const conn = connect();
	await until(() => conn.status.kind === "connected");
	await expect(conn.getStates()).resolves.toEqual([
		{ entity_id: LIVING, ...playing },
		{ entity_id: KITCHEN, ...idle }
	]);
});

test("stop closes the socket, rejects pending requests and never reconnects", async () => {
	useFakeClock();
	fake.holdReplies("get_states");
	const conn = connect();
	await until(() => conn.status.kind === "connected");
	const states = conn.getStates();
	await until(() => fake.sent("get_states").length === 1);
	conn.stop();
	expect(conn.status).toEqual({ kind: "stopped" });
	await expect(states).rejects.toThrow("connection closed");
	await until(() => fake.open === 0);
	await vi.advanceTimersByTimeAsync(60000);
	expect(constructed).toBe(1);
});

describe("a status listener that calls stop() (re-entrant stop)", () => {
	test("from inside unreachable: no reconnect timer and no new socket", async () => {
		useFakeClock();
		const conn = connect();
		await until(() => conn.status.kind === "connected");
		conn.onStatus((s) => {
			if (s.kind === "unreachable") conn.stop();
		});
		fake.dropAll();
		await until(() => conn.status.kind === "stopped");
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(60000);
		expect(constructed).toBe(1);
		expect(conn.status).toEqual({ kind: "stopped" });
	});

	test("from inside connecting: no socket is opened", async () => {
		useFakeClock();
		const conn = new HaConnection({ wsUrl: fake.url, token: TOKEN, WebSocketImpl: CountingWebSocket });
		conns.push(conn);
		conn.onStatus((s) => {
			if (s.kind === "connecting") conn.stop();
		});
		conn.start();
		expect(conn.status).toEqual({ kind: "stopped" });
		expect(constructed).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("from inside connected: no ping timer is left running", async () => {
		useFakeClock();
		const conn = new HaConnection({ wsUrl: fake.url, token: TOKEN, WebSocketImpl: CountingWebSocket });
		conns.push(conn);
		conn.onStatus((s) => {
			if (s.kind === "connected") conn.stop();
		});
		conn.start();
		await until(() => conn.status.kind === "stopped");
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(60000);
		expect(fake.sent("ping")).toHaveLength(0);
		expect(constructed).toBe(1);
	});
});

test("token never logged", async () => {
	const secret = `${TOKEN}-revoked`;
	await fake.close();
	fake = await FakeHa.start({ token: TOKEN, authInvalidMessage: `Invalid access token ${secret}` });
	const lines: string[] = [];
	const logger: ScopedLogger = {
		debug: (m) => lines.push(m),
		info: (m) => lines.push(m),
		warn: (m) => lines.push(m),
		error: (m) => lines.push(m)
	};
	const statuses: ConnStatus[] = [];
	const conn = new HaConnection({ wsUrl: fake.url, token: secret, logger });
	conns.push(conn);
	conn.onStatus((s) => statuses.push(s));
	conn.start();
	await until(() => conn.status.kind === "auth_invalid");
	conn.stop();
	expect(lines.some((l) => l.includes("Invalid access token"))).toBe(true);
	expect(lines.join("\n")).not.toContain(secret);
	expect(JSON.stringify(statuses)).not.toContain(secret);
});

test("getConnection shares by (url, token) and replaces on a token change", async () => {
	const a = getConnection(fake.url, TOKEN);
	conns.push(a);
	expect(getConnection(fake.url, TOKEN)).toBe(a);
	await until(() => a.status.kind === "connected");

	const b = getConnection(fake.url, "other-token");
	conns.push(b);
	expect(b).not.toBe(a);
	expect(a.status).toEqual({ kind: "stopped" });
	await until(() => b.status.kind === "auth_invalid");

	stopConnection(fake.url);
	expect(b.status).toEqual({ kind: "stopped" });
	const c = getConnection(fake.url, "other-token");
	conns.push(c);
	expect(c).not.toBe(b);
	stopConnection(fake.url);
});

describe("diagnosing a wss handshake that fails before open", () => {
	const WSS = "wss://ha.example.com/api/websocket";
	const certError = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("tls"), { code }) });

	/** A socket that never opens: an `error` (no detail, like undici's) and then a 1006 close, on the next turn. */
	class FailingSocket extends EventTarget {
		static opens = false;
		constructor(readonly url: string) {
			super();
			constructed++;
			setImmediate(() => {
				if (FailingSocket.opens) {
					this.dispatchEvent(new Event("open"));
				} else {
					this.dispatchEvent(new Event("error"));
				}
				this.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "" }));
			});
		}
		send(): void {}
		close(): void {}
	}

	function probing(fetchImpl: typeof fetch, extra: Partial<HaConnectionOptions> = {}) {
		const lines: string[] = [];
		const logger: ScopedLogger = { debug() {}, info() {}, warn: (m) => lines.push(m), error: (m) => lines.push(m) };
		const statuses: ConnStatus[] = [];
		const conn = new HaConnection({
			wsUrl: WSS,
			token: TOKEN,
			WebSocketImpl: FailingSocket as unknown as typeof WebSocket,
			fetchImpl,
			logger,
			backoffMinMs: 100,
			backoffMaxMs: 100,
			...extra
		});
		conns.push(conn);
		conn.onStatus((s) => statuses.push(s));
		conn.start();
		return { conn, lines, statuses };
	}

	beforeEach(() => {
		FailingSocket.opens = false;
		vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter
	});

	test("a certificate error from the probe becomes the unreachable detail, logged and without the token", async () => {
		const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(certError("UNABLE_TO_VERIFY_LEAF_SIGNATURE")));
		const { conn, lines } = probing(fetchImpl);
		await until(() => conn.status.kind === "unreachable" && conn.status.detail.startsWith("certificate"));

		expect(conn.status).toEqual({ kind: "unreachable", detail: "certificate not trusted (UNABLE_TO_VERIFY_LEAF_SIGNATURE)" });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://ha.example.com/api/");
		expect(init?.method).toBe("HEAD");
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(JSON.stringify(init?.headers ?? {})).not.toContain(TOKEN);
		expect(JSON.stringify(init ?? {})).not.toMatch(/authorization/i);
		expect(lines.some((l) => l.includes("certificate is not trusted (UNABLE_TO_VERIFY_LEAF_SIGNATURE)"))).toBe(true);
		expect(lines.join("\n")).not.toContain(TOKEN);
	});

	test("one probe per failure streak, and later failures keep the certificate detail", async () => {
		useFakeClock();
		const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(certError("SELF_SIGNED_CERT_IN_CHAIN")));
		const { conn, statuses } = probing(fetchImpl);
		await until(() => conn.status.kind === "unreachable" && conn.status.detail.startsWith("certificate"));
		for (let i = 0; i < 4; i++) {
			await vi.advanceTimersByTimeAsync(100);
			await until(() => conn.status.kind === "unreachable");
		}
		expect(constructed).toBe(5);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		// After the diagnosis, every reconnect attempt goes connecting → the same certificate detail.
		const unreachable = statuses.filter((s) => s.kind === "unreachable").map((s) => (s as { detail: string }).detail);
		expect(unreachable).toEqual(["error", ...Array(5).fill("certificate not trusted (SELF_SIGNED_CERT_IN_CHAIN)")]);
	});

	test("a probe that reaches HA, or fails for another reason, leaves the detail and is not repeated in the streak", async () => {
		useFakeClock();
		for (const outcome of [() => Promise.resolve(new Response(null, { status: 401 })), () => Promise.reject(certError("ECONNREFUSED"))]) {
			constructed = 0;
			const fetchImpl = vi.fn<typeof fetch>(outcome);
			const { conn } = probing(fetchImpl);
			await until(() => conn.status.kind === "unreachable");
			await until(() => fetchImpl.mock.calls.length === 1);
			await new Promise((resolve) => setImmediate(resolve));
			expect(conn.status).toEqual({ kind: "unreachable", detail: "error" });
			await vi.advanceTimersByTimeAsync(100);
			await until(() => constructed === 2 && conn.status.kind === "unreachable");
			expect(fetchImpl).toHaveBeenCalledTimes(1);
			conn.stop();
		}
	});

	test("stop() and start() begin a new streak, which probes again", async () => {
		const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(certError("CERT_HAS_EXPIRED")));
		const { conn } = probing(fetchImpl);
		await until(() => conn.status.kind === "unreachable" && conn.status.detail.startsWith("certificate"));
		conn.stop();
		conn.start();
		await until(() => fetchImpl.mock.calls.length === 2);
	});

	test("a probe result that lands after stop() is dropped", async () => {
		let settle!: (err: unknown) => void;
		const fetchImpl = vi.fn<typeof fetch>(() => new Promise((_, reject) => (settle = reject)));
		const { conn } = probing(fetchImpl);
		await until(() => fetchImpl.mock.calls.length === 1);
		conn.stop();
		settle(certError("UNABLE_TO_VERIFY_LEAF_SIGNATURE"));
		await new Promise((resolve) => setImmediate(resolve));
		expect(conn.status).toEqual({ kind: "stopped" });
	});

	test("never probes for ws://, or for a wss socket that opened and then dropped", async () => {
		const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(certError("UNABLE_TO_VERIFY_LEAF_SIGNATURE")));
		const plain = probing(fetchImpl, { wsUrl: "ws://ha.example.com/api/websocket" });
		await until(() => plain.conn.status.kind === "unreachable");
		plain.conn.stop();

		FailingSocket.opens = true;
		const opened = probing(fetchImpl);
		await until(() => opened.conn.status.kind === "unreachable");
		opened.conn.stop();
		await new Promise((resolve) => setImmediate(resolve));
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
