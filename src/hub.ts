// What every Spindle action shares: the global settings, the one HA connection, the cover loader, the
// frame loop (one 10 sends/s budget for the whole plugin) and the property inspector's status line and
// media-player picker. Actions register two kinds of things here:
// - clients: a session-like target bound to one entity (a dial, a wide pair, a key);
// - surfaces: what the frame loop serves (usually the same widget, keyed by its action id).
import streamDeck from "@elgato/streamdeck";

import { CoverLoader } from "./art/cover";
import { openCapture } from "./capture";
import { bindDial, mediaPlayerItems, statusLine, type BindArgs } from "./dial/binding";
import { getConnection, stopConnection, type HaConnection } from "./ha/connection";
import { redact } from "./log";
import { FrameLoop, type FeedbackSink, type GroupController, type LoopController } from "./loop";
import { normalizeHaUrl, type GlobalSettings } from "./settings";

/** A surface that keeps failing in the loop logs at most once per this long. */
const LOOP_ERROR_LOG_MS = 10_000;

/** The normalised global settings; null when the URL is unusable or the token empty. */
type Config = { wsUrl: string; httpBase: string; host: string; token: string };

/** The shared connection while any client is visible, with what the PI status line needs. */
type Hub = { conn: HaConnection; offStatus: () => void; players?: number };

export type BindTarget = BindArgs["ctl"];
/** `piId`: the action whose property inspector shows this client's media-player picker. */
type Client = { target: BindTarget; entityId: string | null; piId: string; unbind: (() => void) | null; conn: HaConnection | null };

/** The SDK's JsonValue, without importing its transitive @elgato/utils package. */
export type JsonValue = Parameters<typeof streamDeck.ui.sendToPropertyInspector>[0];

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const isGetEvent = (p: JsonValue, name: string): boolean =>
	typeof p === "object" && p !== null && !Array.isArray(p) && p.event === name;

export class SpindleHub {
	private readonly log = streamDeck.logger.createScope("hub");
	private readonly clients = new Map<string, Client>();
	readonly loop = new FrameLoop({ onError: (id, err) => this.loopError(id, err) });
	private readonly loopErrorAt = new Map<string, number>();
	/** undefined until the first global settings arrive; null when they are unusable. */
	private config: Config | null | undefined = undefined;
	private covers: CoverLoader | null = null;
	private hub: Hub | null = null;
	/** Dev-only (SPINDLE_CAPTURE=1 builds); normal builds compile this away. Null when off. */
	readonly capture = __SPINDLE_CAPTURE__ ? openCapture({ info: (m) => this.info(m), warn: (m) => this.warn(m) }) : null;

	/** Applies the global settings (from startup and from every PI change). */
	setGlobalSettings(s: GlobalSettings): void {
		const norm = normalizeHaUrl(s.haUrl);
		const token = typeof s.token === "string" ? s.token.trim() : "";
		const next: Config | null = norm && token ? { ...norm, host: new URL(norm.httpBase).host, token } : null;
		const prev = this.config;
		if (prev !== undefined && prev?.wsUrl === next?.wsUrl && prev?.httpBase === next?.httpBase && prev?.token === next?.token) {
			return;
		}

		// Swap: every client lets go of the old connection (showing a fresh start, not a dimmed
		// "Reconnecting…" of the old player) before the old connection is stopped.
		for (const c of this.clients.values()) this.unbind(c);
		this.releaseHub();
		this.config = next;
		this.covers = next ? new CoverLoader({ httpBase: next.httpBase, token: next.token }) : null;
		this.info(next ? `Home Assistant set to ${next.host}` : "Home Assistant URL or token not set");
		this.ensureHub();
		for (const c of this.clients.values()) this.bind(c);
		this.pushStatus();
	}

	// --- clients ---

	/**
	 * Binds `target` to `entityId` on the shared connection; attaching under an existing id replaces it.
	 * `piId` is the action whose picker belongs to this client, when that is not `id` itself.
	 */
	attach(id: string, target: BindTarget, entityId: string | null, piId = id): void {
		const old = this.clients.get(id);
		if (old) this.unbind(old);
		const c: Client = { target, entityId, piId, unbind: null, conn: null };
		this.clients.set(id, c);
		this.ensureHub();
		this.bind(c);
	}

	/** Rebinds when the entity changed. */
	setEntity(id: string, entityId: string | null): void {
		const c = this.clients.get(id);
		if (!c || c.entityId === entityId) return;
		this.unbind(c);
		c.entityId = entityId;
		this.bind(c);
	}

	detach(id: string): void {
		const c = this.clients.get(id);
		if (!c) return;
		this.unbind(c);
		this.clients.delete(id);
		this.maybeRelease();
	}

	async callService(id: string, service: string, data?: Record<string, unknown>): Promise<void> {
		const c = this.clients.get(id);
		const conn = c?.conn;
		const entityId = c?.entityId;
		try {
			if (!conn || !entityId) throw new Error("not connected");
			await conn.callService("media_player", service, entityId, data);
		} catch (err) {
			this.warn(`media_player.${service} failed: ${errorText(err)}`);
			throw err;
		}
	}

	// --- surfaces ---

	addSurface(id: string, ctl: LoopController, sink: FeedbackSink): void {
		this.loop.add(id, ctl, sink);
		this.loop.start();
	}

	addGroup(id: string, ctl: GroupController, sinks: FeedbackSink[]): void {
		this.loop.addGroup(id, ctl, sinks);
		this.loop.start();
	}

	removeSurface(id: string): void {
		this.loop.remove(id);
		this.loopErrorAt.delete(id);
		this.maybeRelease();
	}

	// --- property inspector ---

	/** Handles the PI's `getMediaPlayers` and `getStatus` requests for the action `actionId`. */
	async onPiRequest(actionId: string, payload: JsonValue): Promise<void> {
		try {
			if (isGetEvent(payload, "getMediaPlayers")) {
				await this.sendMediaPlayers(this.clientFor(actionId)?.entityId ?? undefined);
			} else if (isGetEvent(payload, "getStatus")) {
				this.pushStatus();
			}
		} catch (err) {
			this.warn(`PI request failed: ${errorText(err)}`);
		}
	}

	/** Only reaches a visible PI; the SDK drops it otherwise. */
	sendToPI(payload: JsonValue): void {
		streamDeck.ui.sendToPropertyInspector(payload).catch((err: unknown) => this.warn(`sendToPropertyInspector failed: ${errorText(err)}`));
	}

	// --- logging (every line redacted) ---

	/** SDK event handlers must never throw: the SDK does not catch a handler's rejection. */
	guard(what: string, fn: () => void): void {
		try {
			fn();
		} catch (err) {
			this.warn(`${what} failed: ${errorText(err)}`);
		}
	}

	info(msg: string): void {
		this.log.info(redact(msg, [this.config?.token]));
	}

	warn(msg: string): void {
		this.log.warn(redact(msg, [this.config?.token]));
	}

	// --- connection and binding ---

	/** Takes the shared connection when the settings are usable and a client is visible. */
	private ensureHub(): void {
		const config = this.config;
		if (this.hub || !config || this.clients.size === 0) return;
		const conn = getConnection(config.wsUrl, config.token);
		const hub: Hub = { conn, offStatus: () => {} };
		hub.offStatus = conn.onStatus((s) => {
			// Never stop a connection from in here (a re-entrant stop leaves a zombie reconnect).
			hub.players = undefined;
			// Deferred so the request does not go out from inside the connection's own handshake handler.
			if (s.kind === "connected") queueMicrotask(() => void this.countPlayers(hub));
			this.pushStatus();
		});
		this.hub = hub;
		if (conn.status.kind === "connected") void this.countPlayers(hub);
	}

	private clientFor(piId: string): Client | undefined {
		for (const c of this.clients.values()) if (c.piId === piId) return c;
		return undefined;
	}

	/** Once nothing is visible: stop the loop and let go of the connection. */
	private maybeRelease(): void {
		if (this.clients.size > 0 || this.loop.size > 0) return;
		this.loop.stop();
		// A rejected token stays rejected (no socket, no timers): keeping it means a page switch
		// does not retry the bad token, which HA would count toward an IP ban.
		if (this.hub?.conn.status.kind !== "auth_invalid") this.releaseHub();
	}

	/** Called only from event handlers: settings changes and willDisappear. */
	private releaseHub(): void {
		const hub = this.hub;
		const config = this.config;
		if (!hub) return;
		this.hub = null;
		hub.offStatus();
		if (config) stopConnection(config.wsUrl);
	}

	private bind(c: Client): void {
		if (c.unbind) return;
		const entityId = c.entityId;
		const hub = this.hub;
		const covers = this.covers;
		if (!hub || !covers || !entityId) {
			// Before the first global settings arrive, say "Connecting…" rather than flash the setup message.
			c.target.setConnStatus(this.config === undefined && entityId ? { kind: "connecting" } : null);
			return;
		}
		c.conn = hub.conn;
		c.unbind = bindDial({
			conn: hub.conn,
			covers,
			ctl: c.target,
			entityId,
			now: Date.now,
			schedule: (fn, ms) => {
				const t = setTimeout(fn, ms);
				return () => clearTimeout(t);
			}
		});
	}

	/** Leaves the target fresh, so the next status starts it over. */
	private unbind(c: Client): void {
		c.unbind?.();
		c.unbind = null;
		c.conn = null;
		c.target.setConnStatus(null);
	}

	/** After each connect: count media players for the status line and refresh an open picker. */
	private async countPlayers(hub: Hub): Promise<void> {
		let states;
		try {
			states = await hub.conn.getStates();
		} catch (err) {
			if (this.hub === hub) this.warn(`get_states failed: ${errorText(err)}`);
			return;
		}
		if (this.hub !== hub || hub.conn.status.kind !== "connected") return;
		hub.players = states.filter((s) => typeof s.entity_id === "string" && s.entity_id.startsWith("media_player.")).length;
		this.pushStatus();
		const open = streamDeck.ui.action;
		const c = open ? this.clientFor(open.id) : undefined;
		if (c) this.sendToPI({ event: "getMediaPlayers", items: mediaPlayerItems(states, c.entityId ?? undefined) });
	}

	/** Replies to the picker's datasource request; `items: []` when not connected or on failure. */
	private async sendMediaPlayers(current: string | undefined): Promise<void> {
		const conn = this.hub?.conn;
		let items: Array<{ value: string; label: string }> = [];
		if (conn?.status.kind === "connected") {
			try {
				items = mediaPlayerItems(await conn.getStates(), current);
			} catch (err) {
				this.warn(`get_states failed: ${errorText(err)}`);
			}
		}
		this.sendToPI({ event: "getMediaPlayers", items });
	}

	private pushStatus(): void {
		const config = this.config;
		const hub = this.hub;
		const status = config ? (hub?.conn.status ?? { kind: "connecting" as const }) : null;
		this.sendToPI({ event: "status", text: statusLine(status, config?.host ?? "", hub?.players) });
	}

	private loopError(id: string, err: unknown): void {
		const now = Date.now();
		const last = this.loopErrorAt.get(id);
		if (last !== undefined && now - last < LOOP_ERROR_LOG_MS) return;
		this.loopErrorAt.set(id, now);
		this.warn(`Surface ${id} frame failed: ${errorText(err)}`);
	}
}
