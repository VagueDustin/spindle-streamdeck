import { redact } from "../log";
import { tlsHandshakeCertError, type TlsConnect } from "../tlsTrust";
import { applyCompressed, applyStateChanged } from "./entityStream";
import type { RawEntity } from "./playerState";

export type ConnStatus =
	| { kind: "connecting" }
	| { kind: "connected"; haVersion: string }
	| { kind: "auth_invalid" }
	/** `cause: "certificate"`: the TLS probe found the server's certificate is not trusted (see `detail`). */
	| { kind: "unreachable"; detail: string; cause?: "certificate" }
	| { kind: "stopped" };

export type ScopedLogger = {
	debug(msg: string): void;
	info(msg: string): void;
	warn(msg: string): void;
	error(msg: string): void;
};

export type HaConnectionOptions = {
	wsUrl: string;
	token: string;
	/** Default `globalThis.WebSocket`. */
	WebSocketImpl?: typeof WebSocket;
	/** Default 30000 / 10000. `pongTimeoutMs` also bounds opening and authenticating a socket. */
	pingIntervalMs?: number;
	pongTimeoutMs?: number;
	/** Default 1000 / 30000; doubles per consecutive failure, ±20% jitter, resets after `auth_ok`. */
	backoffMinMs?: number;
	backoffMaxMs?: number;
	/** Default: the logger passed to `setConnectionLogger`, else silent. Every line is redacted. */
	logger?: ScopedLogger;
	/** Default `tls.connect`. Used only for the TLS-only probe after a wss:// socket fails before it opens. */
	tlsConnect?: TlsConnect;
};

export type HaState = { entity_id: string; state: string; attributes: Record<string, unknown> };

type Dict = Record<string, unknown>;
type EntityCallback = (raw: RawEntity | null) => void;
type Pending = { resolve: (result: unknown) => void; reject: (err: Error) => void };
type Timer = ReturnType<typeof setTimeout>;

/** Bounds the one-off TLS handshake probe that diagnoses a wss:// failure. */
const PROBE_TIMEOUT_MS = 5000;

const SILENT: ScopedLogger = { debug() {}, info() {}, warn() {}, error() {} };
let defaultLogger: ScopedLogger = SILENT;

/** Sets the logger used by connections created without one (plugin.ts passes `streamDeck.logger.createScope("ha")`). */
export function setConnectionLogger(logger: ScopedLogger): void {
	defaultLogger = logger;
}

function isDict(value: unknown): value is Dict {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function certDetail(code: string): string {
	return `certificate not trusted (${code})`;
}

function certAdvice(code: string): string {
	switch (code) {
		case "ERR_TLS_CERT_ALTNAME_INVALID":
			return "its name doesn't match the host in the URL. Use the name the certificate was issued for.";
		case "CERT_HAS_EXPIRED":
			return "it has expired. Renew it on the Home Assistant side.";
		default:
			return "add its CA to this computer's certificate store, then restart Stream Deck.";
	}
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** One WebSocket to one Home Assistant, shared by every dial that uses it (spec §3). */
export class HaConnection {
	private readonly wsUrl: string;
	private readonly token: string;
	private readonly WebSocketImpl: typeof WebSocket;
	private readonly pingIntervalMs: number;
	private readonly pongTimeoutMs: number;
	private readonly backoffMinMs: number;
	private readonly backoffMaxMs: number;
	private readonly logger?: ScopedLogger;
	private readonly tlsConnect?: TlsConnect;

	private current: ConnStatus = { kind: "stopped" };
	private readonly statusListeners = new Set<(s: ConnStatus) => void>();
	/** True from start() until stop(); stays true after auth_invalid so start() won't retry a bad token. */
	private running = false;

	private ws: WebSocket | null = null;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private failures = 0;
	/**
	 * A failure streak runs from start() or auth_ok to the next of either. `streak` numbers it, so a
	 * probe result from an older streak is dropped; each streak probes at most once and keeps what it found.
	 */
	private streak = 0;
	private probed = false;
	/** The certificate error code the probe found in this streak. */
	private certCode: string | undefined;
	private reconnectTimer?: Timer;
	private connectTimer?: Timer;
	private pingTimer?: ReturnType<typeof setInterval>;
	private pongTimer?: Timer;

	private readonly subs = new Map<string, Set<{ cb: EntityCallback }>>();
	private readonly store = new Map<string, RawEntity>();
	/** Subscribed ids already reported absent with cb(null). */
	private readonly missing = new Set<string>();
	/** Per socket: `subscribe_entities`, or the `state_changed` fallback once HA rejects it. */
	private mode: "entities" | "events" = "entities";
	private entitySub: { id: number; ids: string[]; awaitingSnapshot: boolean } | null = null;
	private eventSub: number | null = null;
	private syncQueued = false;
	/** Bumped by every sync and socket teardown, so a superseded sync drops its late results. */
	private syncGen = 0;

	constructor(opts: HaConnectionOptions) {
		this.wsUrl = opts.wsUrl;
		this.token = opts.token;
		this.WebSocketImpl = opts.WebSocketImpl ?? globalThis.WebSocket;
		this.pingIntervalMs = opts.pingIntervalMs ?? 30000;
		this.pongTimeoutMs = opts.pongTimeoutMs ?? 10000;
		this.backoffMinMs = opts.backoffMinMs ?? 1000;
		this.backoffMaxMs = opts.backoffMaxMs ?? 30000;
		this.logger = opts.logger;
		this.tlsConnect = opts.tlsConnect;
	}

	get status(): ConnStatus {
		return this.current;
	}

	/** Calls `cb` on every status change. Returns an unsubscribe function. */
	onStatus(cb: (s: ConnStatus) => void): () => void {
		this.statusListeners.add(cb);
		return () => this.statusListeners.delete(cb);
	}

	/** Starts connecting. A no-op while started, including after auth_invalid. */
	start(): void {
		if (this.running) {
			return;
		}
		this.running = true;
		this.newStreak();
		this.open();
	}

	/** Closes the socket, rejects pending requests and cancels every timer. No reconnect until start(). */
	stop(): void {
		this.running = false;
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		this.dropSocket();
		this.store.clear();
		this.missing.clear();
		this.setStatus({ kind: "stopped" });
	}

	/** Ref-counted per entity. cb(raw) on every change; cb(null) if the entity is absent or removed. */
	subscribeEntity(entityId: string, cb: (raw: RawEntity | null) => void): () => void {
		let entries = this.subs.get(entityId);
		if (!entries) {
			entries = new Set();
			this.subs.set(entityId, entries);
			this.queueSync();
		}
		const entry = { cb };
		entries.add(entry);

		// A late subscriber gets the current value now rather than at the next diff.
		queueMicrotask(() => {
			if (!this.subs.get(entityId)?.has(entry)) {
				return;
			}
			const raw = this.store.get(entityId);
			if (raw) {
				this.invoke(entry.cb, raw);
			} else if (this.missing.has(entityId)) {
				this.invoke(entry.cb, null);
			}
		});

		return () => {
			const current = this.subs.get(entityId);
			if (!current?.delete(entry) || current.size > 0) {
				return;
			}
			this.subs.delete(entityId);
			this.store.delete(entityId);
			this.missing.delete(entityId);
			this.queueSync();
		};
	}

	/** Rejects with Error("not connected") unless connected; calls are never queued across a reconnect. */
	async callService(domain: "media_player", service: string, entityId: string, data?: Record<string, unknown>): Promise<void> {
		this.requireConnected();
		await this.request({
			type: "call_service",
			domain,
			service,
			target: { entity_id: entityId },
			...(data ? { service_data: data } : {})
		}).result;
	}

	async getStates(): Promise<HaState[]> {
		this.requireConnected();
		const result = await this.request({ type: "get_states" }).result;
		return Array.isArray(result) ? (result as HaState[]) : [];
	}

	// --- socket lifecycle ---

	private open(): void {
		this.setStatus({ kind: "connecting" });
		// A status listener may have called stop(): open nothing.
		if (!this.running) {
			return;
		}
		let ws: WebSocket;
		try {
			ws = new this.WebSocketImpl(this.wsUrl);
		} catch (err) {
			this.lostConnection(`error: ${errorText(err)}`);
			return;
		}
		this.ws = ws;
		this.nextId = 1;
		this.mode = "entities";
		this.connectTimer = setTimeout(() => this.lostConnection("timed out connecting"), this.pongTimeoutMs);

		let lastError: string | undefined;
		let opened = false;
		ws.addEventListener("open", () => {
			opened = true;
		});
		ws.addEventListener("message", (ev) => {
			if (this.ws === ws) {
				this.onRaw(ev.data);
			}
		});
		ws.addEventListener("error", (ev) => {
			const message = (ev as { message?: unknown }).message;
			lastError = typeof message === "string" && message ? `error: ${message}` : "error";
		});
		ws.addEventListener("close", (ev) => {
			if (this.ws !== ws) {
				return;
			}
			const detail = lastError ?? `closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ""})`;
			if (opened) {
				this.lostConnection(detail);
				return;
			}
			// Failed before it opened. undici reports a TLS failure as a bare error event, so for wss://
			// probe the TLS handshake once per streak, and keep a certificate diagnosis for the streak.
			if (this.certCode) {
				this.lostConnection(certDetail(this.certCode), "certificate");
			} else {
				this.lostConnection(detail);
			}
			this.probeTls();
		});
	}

	/** Forgets the current socket (its late events are ignored) and closes it without waiting for the handshake. */
	private dropSocket(): void {
		const ws = this.ws;
		this.ws = null;
		clearTimeout(this.connectTimer);
		clearInterval(this.pingTimer);
		clearTimeout(this.pongTimer);
		this.connectTimer = this.pingTimer = this.pongTimer = undefined;
		this.entitySub = null;
		this.eventSub = null;
		this.syncGen++;
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const p of pending) {
			p.reject(new Error("connection closed"));
		}
		if (ws) {
			try {
				ws.close();
			} catch {
				// already closing
			}
		}
	}

	private lostConnection(detail: string, cause?: "certificate"): void {
		this.dropSocket();
		if (!this.running) {
			return;
		}
		const base = Math.min(this.backoffMaxMs, this.backoffMinMs * 2 ** this.failures);
		const delay = Math.min(this.backoffMaxMs, Math.round(base * (0.8 + Math.random() * 0.4)));
		this.failures = Math.min(this.failures + 1, 30);
		const safeDetail = this.redact(detail);
		this.setStatus({ kind: "unreachable", detail: safeDetail, ...(cause ? { cause } : {}) });
		// A status listener may have called stop(): schedule no reconnect.
		if (!this.running) {
			return;
		}
		this.log("warn", `Home Assistant unreachable (${safeDetail}); retrying in ${delay} ms`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.open();
		}, delay);
	}

	private newStreak(): void {
		this.failures = 0;
		this.streak++;
		this.probed = false;
		this.certCode = undefined;
	}

	/**
	 * After a wss:// socket fails before opening: one TLS-only handshake with HA's host and port, to
	 * learn whether the certificate is the problem (the WebSocket's error event carries no code). No
	 * HTTP request reaches HA, so the probe can never count as a failed login toward an IP ban.
	 */
	private probeTls(): void {
		if (this.probed || !this.running) {
			return;
		}
		let host: string;
		let port: number;
		try {
			const url = new URL(this.wsUrl);
			if (url.protocol !== "wss:") {
				return;
			}
			host = url.hostname.replace(/^\[(.*)\]$/, "$1");
			port = Number(url.port) || 443;
		} catch {
			return;
		}
		this.probed = true;
		const streak = this.streak;
		tlsHandshakeCertError(host, port, PROBE_TIMEOUT_MS, this.tlsConnect)
			.then((code) => {
				if (!code || !this.running || streak !== this.streak) {
					return;
				}
				this.certCode = code;
				this.log("warn", `Home Assistant's certificate is not trusted (${code}): ${certAdvice(code)}`);
				if (this.current.kind === "unreachable") {
					this.setStatus({ kind: "unreachable", detail: certDetail(code), cause: "certificate" });
				}
			})
			.catch((err: unknown) => this.log("error", `TLS probe failed: ${errorText(err)}`));
	}

	private onRaw(data: unknown): void {
		if (typeof data !== "string") {
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			this.log("warn", "Ignoring a non-JSON message from Home Assistant");
			return;
		}
		for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
			if (isDict(msg)) {
				this.onMessage(msg);
			}
		}
	}

	private onMessage(msg: Dict): void {
		switch (msg.type) {
			case "auth_required":
				this.send({ type: "auth", access_token: this.token });
				break;
			case "auth_ok": {
				clearTimeout(this.connectTimer);
				this.connectTimer = undefined;
				this.newStreak();
				const haVersion = typeof msg.ha_version === "string" ? msg.ha_version : "unknown";
				this.setStatus({ kind: "connected", haVersion });
				// A status listener may have called stop(): start no ping timer and no sync.
				if (!this.running) {
					break;
				}
				this.log("info", `Connected to Home Assistant ${haVersion}`);
				this.pingTimer = setInterval(() => this.ping(), this.pingIntervalMs);
				void this.sync();
				break;
			}
			case "auth_invalid":
				// HA counts bad auth toward IP bans: never retry this token.
				this.log("error", `Home Assistant rejected the token (auth_invalid: ${String(msg.message ?? "")})`);
				this.dropSocket();
				this.setStatus({ kind: "auth_invalid" });
				break;
			case "pong":
				clearTimeout(this.pongTimer);
				this.pongTimer = undefined;
				break;
			case "result":
				this.onResult(msg);
				break;
			case "event":
				this.onEvent(msg);
				break;
		}
	}

	private ping(): void {
		if (this.pongTimer) {
			return;
		}
		this.send({ id: this.nextId++, type: "ping" });
		this.pongTimer = setTimeout(() => {
			this.pongTimer = undefined;
			this.lostConnection(`no pong within ${this.pongTimeoutMs} ms`);
		}, this.pongTimeoutMs);
	}

	// --- requests ---

	private requireConnected(): void {
		if (this.current.kind !== "connected") {
			throw new Error("not connected");
		}
	}

	private send(msg: Dict): void {
		this.ws?.send(JSON.stringify(msg));
	}

	private request(payload: Dict): { id: number; result: Promise<unknown> } {
		const id = this.nextId++;
		const result = new Promise<unknown>((resolve, reject) => {
			if (!this.ws) {
				reject(new Error("not connected"));
				return;
			}
			this.pending.set(id, { resolve, reject });
			this.send({ id, ...payload });
		});
		return { id, result };
	}

	private onResult(msg: Dict): void {
		const id = msg.id as number;
		const pending = this.pending.get(id);
		if (!pending) {
			return;
		}
		this.pending.delete(id);
		if (msg.success === true) {
			pending.resolve(msg.result);
			return;
		}
		const error = isDict(msg.error) ? msg.error : {};
		const code = typeof error.code === "string" ? error.code : "unknown_error";
		const message = typeof error.message === "string" ? error.message : "request failed";
		pending.reject(new Error(this.redact(`${code}: ${message}`)));
	}

	// --- subscriptions ---

	private queueSync(): void {
		if (this.syncQueued) {
			return;
		}
		this.syncQueued = true;
		queueMicrotask(() => {
			this.syncQueued = false;
			void this.sync();
		});
	}

	/** Brings the server-side subscription in line with the subscribed ids: one subscription covering the union. */
	private async sync(): Promise<void> {
		if (this.current.kind !== "connected") {
			return; // auth_ok syncs
		}
		const gen = ++this.syncGen;
		const ids = [...this.subs.keys()];

		if (this.mode === "entities") {
			if (this.entitySub) {
				this.unsubscribe(this.entitySub.id);
				this.entitySub = null;
			}
			if (ids.length === 0) {
				return;
			}
			const { id, result } = this.request({ type: "subscribe_entities", entity_ids: ids });
			this.entitySub = { id, ids, awaitingSnapshot: true };
			this.log("debug", `Subscribed to ${ids.join(", ")}`);
			try {
				await result;
			} catch (err) {
				if (gen !== this.syncGen) {
					return; // superseded, or the socket closed
				}
				this.entitySub = null;
				this.mode = "events";
				this.log("warn", `subscribe_entities rejected (${errorText(err)}); falling back to state_changed`);
				await this.sync();
			}
			return;
		}

		if (ids.length === 0) {
			if (this.eventSub !== null) {
				this.unsubscribe(this.eventSub);
				this.eventSub = null;
			}
			return;
		}
		if (this.eventSub === null) {
			const { id, result } = this.request({ type: "subscribe_events", event_type: "state_changed" });
			this.eventSub = id;
			result.catch((err: unknown) => this.log("warn", `subscribe_events failed: ${errorText(err)}`));
		}
		let states: unknown;
		try {
			states = await this.request({ type: "get_states" }).result;
		} catch (err) {
			if (gen === this.syncGen) {
				this.log("warn", `get_states failed: ${errorText(err)}`);
			}
			return;
		}
		if (gen !== this.syncGen || !Array.isArray(states)) {
			return;
		}
		const changed = new Set<string>();
		for (const id of ids) {
			if (!this.subs.has(id)) {
				continue;
			}
			const found = states.find((s): s is HaState => isDict(s) && s.entity_id === id);
			if (found && typeof found.state === "string") {
				this.store.set(id, { state: found.state, attributes: isDict(found.attributes) ? { ...found.attributes } : {} });
			} else {
				this.store.delete(id);
			}
			changed.add(id);
		}
		this.emit(changed);
	}

	private unsubscribe(subscription: number): void {
		this.request({ type: "unsubscribe_events", subscription }).result.catch(() => {
			// the subscription dies with the socket anyway
		});
	}

	private onEvent(msg: Dict): void {
		const sub = this.entitySub;
		if (sub && msg.id === sub.id) {
			const changed = new Set<string>();
			if (sub.awaitingSnapshot) {
				// HA's first event is the full snapshot: anything not in it is absent.
				sub.awaitingSnapshot = false;
				const present = isDict(msg.event) && isDict(msg.event.a) ? msg.event.a : {};
				for (const id of sub.ids) {
					if (!Object.hasOwn(present, id)) {
						this.store.delete(id);
						changed.add(id);
					}
				}
			}
			for (const id of applyCompressed(this.store, msg.event)) {
				changed.add(id);
			}
			this.emit(changed);
		} else if (this.eventSub !== null && msg.id === this.eventSub) {
			const event = isDict(msg.event) ? msg.event : {};
			const data = isDict(event.data) ? event.data : {};
			if (typeof data.entity_id === "string" && this.subs.has(data.entity_id)) {
				this.emit(applyStateChanged(this.store, event));
			}
		}
	}

	/** Calls subscribers of each id: cb(raw) when present, cb(null) once when absent. */
	private emit(ids: Set<string>): void {
		for (const id of ids) {
			const entries = this.subs.get(id);
			if (!entries) {
				this.store.delete(id);
				continue;
			}
			const raw = this.store.get(id) ?? null;
			if (raw) {
				this.missing.delete(id);
			} else if (this.missing.has(id)) {
				continue;
			} else {
				this.missing.add(id);
			}
			for (const entry of [...entries]) {
				this.invoke(entry.cb, raw);
			}
		}
	}

	private invoke(cb: EntityCallback, raw: RawEntity | null): void {
		try {
			cb(raw);
		} catch (err) {
			this.log("error", `Entity callback threw: ${errorText(err)}`);
		}
	}

	// --- status and logging ---

	private setStatus(next: ConnStatus): void {
		if (JSON.stringify(next) === JSON.stringify(this.current)) {
			return;
		}
		this.current = next;
		for (const listener of [...this.statusListeners]) {
			try {
				listener(next);
			} catch (err) {
				this.log("error", `Status listener threw: ${errorText(err)}`);
			}
		}
	}

	private redact(text: string): string {
		return redact(text, [this.token]);
	}

	private log(level: keyof ScopedLogger, msg: string): void {
		(this.logger ?? defaultLogger)[level](this.redact(msg));
	}
}

const registry = new Map<string, { token: string; conn: HaConnection }>();

/** Same (url, token) → same started instance. A different token for the same URL stops and replaces the old one. */
export function getConnection(wsUrl: string, token: string): HaConnection {
	const entry = registry.get(wsUrl);
	if (entry?.token === token) {
		entry.conn.start();
		return entry.conn;
	}
	entry?.conn.stop();
	const conn = new HaConnection({ wsUrl, token });
	registry.set(wsUrl, { token, conn });
	conn.start();
	return conn;
}

/** Stops the connection for this URL and forgets it (once no dial uses it). */
export function stopConnection(wsUrl: string): void {
	registry.get(wsUrl)?.conn.stop();
	registry.delete(wsUrl);
}
