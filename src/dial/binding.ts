// Connects one dial controller to one HA entity: connection status, entity updates and the
// cover art for the current picture. No SDK and no timers of its own (the cover retry goes
// through the injected `schedule`), so it is unit-testable.
import { coverKey, type CoverLoader } from "../art/cover";
import type { ConnStatus, HaConnection } from "../ha/connection";
import { toPlayerState } from "../ha/playerState";
import type { DialController } from "./controller";

/** A failed cover load is retried after this long... */
export const COVER_RETRY_MS = 5000;
/** ...this many times per picture (so at most 1 + COVER_RETRIES loads). */
export const COVER_RETRIES = 3;

export type BindArgs = {
	conn: Pick<HaConnection, "subscribeEntity" | "onStatus" | "status" | "callService">;
	covers: Pick<CoverLoader, "load">;
	ctl: Pick<DialController, "setConnStatus" | "setPlayer" | "setCover" | "coverKey">;
	entityId: string;
	now: () => number;
	schedule: (fn: () => void, ms: number) => () => void;
};

/** Binds the controller to the entity on this connection. Returns the unbind function. */
export function bindDial(args: BindArgs): () => void {
	const { conn, covers, ctl, entityId, schedule } = args;
	let active = true;
	/**
	 * The picture's `coverKey` (stable across HA's proxy-token rotation). null until the first
	 * update, so the first one always sets the cover (a rebound controller may hold an old one).
	 */
	let picture: string | undefined | null = null;
	/** The newest full picture URL: loads and retries fetch with its current token. */
	let pictureUrl: string | undefined;
	let retries = 0;
	/** Bumped on every picture change and on unbind, so a superseded load drops its result. */
	let gen = 0;
	let cancelRetry: (() => void) | null = null;

	const clearRetry = () => {
		cancelRetry?.();
		cancelRetry = null;
	};

	const load = (url: string, myGen: number) => {
		covers.load(url).then(
			(result) => {
				if (active && myGen === gen) ctl.setCover(result);
			},
			() => {
				if (!active || myGen !== gen) return;
				// Spec 7: the previous backdrop is kept. The controller already shows this very picture.
				if (ctl.coverKey === picture) return;
				ctl.setCover(null);
				if (retries >= COVER_RETRIES) return;
				retries++;
				cancelRetry = schedule(() => {
					cancelRetry = null;
					if (active && myGen === gen && pictureUrl) load(pictureUrl, myGen);
				}, COVER_RETRY_MS);
			}
		);
	};

	ctl.setConnStatus(conn.status);
	const offStatus = conn.onStatus((s) => {
		if (active) ctl.setConnStatus(s);
	});
	const offEntity = conn.subscribeEntity(entityId, (raw) => {
		if (!active) return;
		const player = raw ? toPlayerState(entityId, raw) : null;
		ctl.setPlayer(player);
		pictureUrl = player?.pictureUrl;
		const next = pictureUrl === undefined ? undefined : coverKey(pictureUrl);
		if (next === picture) return;
		picture = next;
		retries = 0;
		gen++;
		clearRetry();
		if (pictureUrl) load(pictureUrl, gen);
		else ctl.setCover(null);
	});

	return () => {
		if (!active) return;
		active = false;
		gen++;
		clearRetry();
		offStatus();
		offEntity();
	};
}

/** The PI picker's items: media players only, "Friendly (entity_id)", sorted case-insensitively. */
export function mediaPlayerItems(
	states: Array<{ entity_id: string; attributes: Record<string, unknown> }>,
	current?: string
): Array<{ value: string; label: string }> {
	const items = states
		.filter((s) => typeof s.entity_id === "string" && s.entity_id.startsWith("media_player."))
		.map((s) => {
			const friendly = s.attributes?.friendly_name;
			const name = typeof friendly === "string" && friendly.trim() ? friendly : s.entity_id;
			return { value: s.entity_id, label: `${name} (${s.entity_id})` };
		})
		.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
	if (current && !items.some((i) => i.value === current)) {
		items.push({ value: current, label: `(not found) ${current}` });
	}
	return items;
}

/**
 * The PI status line (spec 8). `status` null means no usable URL or token. `host` comes from the
 * normalised URL. `players` is the media-player count from the get_states after this connect;
 * until it arrives a connected status still reads "Connecting…".
 */
export function statusLine(status: ConnStatus | null, host: string, players: number | undefined): string {
	if (!status) return "Enter your Home Assistant URL and token";
	switch (status.kind) {
		case "connected":
			return players === undefined ? "Connecting…" : `Connected · HA ${status.haVersion} · ${players} media players`;
		case "auth_invalid":
			return "Token rejected";
		case "unreachable":
			return `Can't reach ${host}`;
		default:
			return "Connecting…";
	}
}
