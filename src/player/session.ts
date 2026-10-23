// One widget's view of one HA media player: connection and player state, the cover, the local echo of
// volume and mute, and the commands. Shared by every surface (dial, wide pair, keys); it draws nothing.
// No SDK and no timers: input reads the clock through `now()`, and whatever expires happens in `tick(t)`.
// `rev` goes up whenever something a surface shows may have changed; `coverRev` when the cover did.
import type { CoverResult } from "../art/cover";
import type { ConnStatus } from "../ha/connection";
import { Feature, has, type PlayerState } from "../ha/playerState";

/** volume_set fires this long after the last detent. */
export const VOLUME_DEBOUNCE_MS = 150;
/** After local volume input, HA-reported volume and mute are ignored this long. */
export const ADOPT_GUARD_MS = 2500;
/** Detents in one direction per track skip, and the pause after a skip. */
export const SKIP_TICKS = 4;
export const SKIP_COOLDOWN_MS = 600;
/** At most one alert per widget this often: a spun dial would otherwise exceed Elgato's 10 calls/s guideline. */
export const ALERT_THROTTLE_MS = 500;

export const SETUP = "Set up Spindle in Stream Deck";
export const CHECK_TOKEN = "Check token";
export const CONNECTING = "Connecting…";
export const NOT_FOUND = "Player not found";
export const RECONNECTING = "Reconnecting…";

export type ServiceCall = (service: string, data?: Record<string, unknown>) => Promise<void>;
export type SessionDeps = {
	now: () => number;
	call: ServiceCall;
	alert: () => void;
};
export type SessionSettings = { entityId: string | null; volumeStep: number; labels: Map<string, string> };

export type Message = { headline: string; sub?: string };
/** What a surface shows. `blocked`: input is refused with an alert. */
export type View = { player: PlayerState | null; message?: Message; dimmed: boolean; badge?: string; blocked: boolean };

const messageView = (headline: string, sub?: string): View => ({
	player: null,
	message: sub === undefined ? { headline } : { headline, sub },
	dimmed: false,
	blocked: true
});
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class PlayerSession {
	/** Bumped on every change a surface may show. */
	rev = 0;
	/** Bumped when the cover changes. */
	coverRev = 0;
	private settingsValue: SessionSettings;
	private conn: ConnStatus | null = null;
	/** Whether this connection has ever reached `connected`; decides "Connecting…" vs "Reconnecting…". */
	private everConnected = false;
	/** undefined until the entity stream first reports; null when HA has no such entity. */
	private player: PlayerState | null | undefined = undefined;
	private coverValue: CoverResult | null = null;

	private volumeValue = 0;
	private mutedValue = false;
	private volumeSendAt: number | null = null;
	private guardUntil: number | null = null;
	private skipCount = 0;
	private skipDir = 0;
	private cooldownUntil = -Infinity;
	private lastAlertAt = -Infinity;

	constructor(
		private readonly deps: SessionDeps,
		settings: SessionSettings
	) {
		this.settingsValue = settings;
	}

	get settings(): SessionSettings {
		return this.settingsValue;
	}

	get volume(): number {
		return this.volumeValue;
	}

	get muted(): boolean {
		return this.mutedValue;
	}

	/** The last player state HA reported, whatever the view shows; undefined before the first, null when missing. */
	get latestPlayer(): PlayerState | null | undefined {
		return this.player;
	}

	get cover(): CoverResult | null {
		return this.coverValue;
	}

	/** The shown cover's `coverKey`; null while there is none. */
	get coverKey(): string | null {
		return this.coverValue?.key ?? null;
	}

	updateSettings(s: SessionSettings): void {
		if (s.entityId !== this.settingsValue.entityId) {
			this.player = undefined;
			this.cancelPending();
		}
		this.settingsValue = s;
		this.rev++;
	}

	/** null = not configured (no URL or token). */
	setConnStatus(s: ConnStatus | null): void {
		this.conn = s;
		if (s?.kind === "connected") {
			this.everConnected = true;
		} else {
			// Review Focus 4: nothing typed while disconnected, or still queued, fires after a reconnect.
			this.cancelPending();
			if (!s || s.kind === "stopped" || s.kind === "auth_invalid") {
				// A new connection follows: show "Connecting…" until it delivers fresh state.
				this.everConnected = false;
				this.player = undefined;
			}
		}
		this.rev++;
	}

	/** null = the entity is missing from HA. */
	setPlayer(p: PlayerState | null): void {
		this.player = p;
		if (this.guardUntil === null || this.deps.now() >= this.guardUntil) this.adopt();
		this.rev++;
	}

	/** null = no art, or it failed. */
	setCover(c: CoverResult | null): void {
		if ((c?.key ?? null) === (this.coverValue?.key ?? null)) return;
		this.coverValue = c;
		this.coverRev++;
		this.rev++;
	}

	tick(t: number): void {
		if (this.volumeSendAt !== null && t >= this.volumeSendAt) {
			this.volumeSendAt = null;
			this.send("volume_set", { volume_level: Math.round(this.volumeValue) / 100 });
		}
		if (this.guardUntil !== null && t >= this.guardUntil) {
			this.guardUntil = null;
			this.adopt();
		}
	}

	/** One view per connection and player state, checked top to bottom. */
	view(): View {
		const c = this.conn;
		if (!c || c.kind === "stopped" || !this.settingsValue.entityId) return messageView(SETUP);
		if (c.kind === "auth_invalid") return messageView(CHECK_TOKEN);
		const reconnecting = c.kind === "unreachable" || (c.kind === "connecting" && this.everConnected);
		if (c.kind === "connecting" && !reconnecting) return messageView(CONNECTING);
		const base = this.playerView(this.settingsValue.entityId);
		return reconnecting ? { ...base, dimmed: true, badge: RECONNECTING, blocked: true } : base;
	}

	/** The player when input is allowed; otherwise alerts and returns null. */
	inputPlayer(): PlayerState | null {
		const v = this.view();
		if (v.blocked || !v.player) {
			this.alert();
			return null;
		}
		return v.player;
	}

	feature(f: number): boolean {
		return !!this.player && has(this.player, f);
	}

	hasVolume(): boolean {
		return this.feature(Feature.VOLUME_SET) || this.feature(Feature.VOLUME_STEP);
	}

	/**
	 * Moves the local volume by `ticks` volume steps and queues the change for HA: one debounced
	 * volume_set, or one volume_up/down per tick for step-only players. False when the player has
	 * no volume control. The caller has already checked `inputPlayer()`.
	 */
	stepVolume(ticks: number, now: number): boolean {
		const canSet = this.feature(Feature.VOLUME_SET);
		if (!canSet && !this.feature(Feature.VOLUME_STEP)) return false;
		this.volumeValue = clamp(this.volumeValue + ticks * this.settingsValue.volumeStep, 0, 100);
		if (ticks > 0) this.mutedValue = false;
		this.guardUntil = now + ADOPT_GUARD_MS;
		this.rev++;
		if (canSet) {
			this.volumeSendAt = now + VOLUME_DEBOUNCE_MS;
		} else {
			for (let i = 0; i < Math.abs(ticks); i++) this.send(ticks > 0 ? "volume_up" : "volume_down");
		}
		return true;
	}

	/** Flips mute locally and in HA. False (with an alert) when the player can't mute. */
	toggleMute(now: number): boolean {
		if (!this.feature(Feature.VOLUME_MUTE)) {
			this.alert();
			return false;
		}
		this.mutedValue = !this.mutedValue;
		this.guardUntil = now + ADOPT_GUARD_MS;
		this.rev++;
		this.send("volume_mute", { is_volume_muted: this.mutedValue });
		return true;
	}

	/**
	 * Counts detents toward a track skip: SKIP_TICKS in one direction fire one skip, then a cooldown.
	 * Returns the direction that fired, or 0.
	 */
	skipTicks(ticks: number, now: number): -1 | 0 | 1 {
		if (now < this.cooldownUntil) return 0;
		const dir = ticks > 0 ? 1 : -1;
		if (dir !== this.skipDir) {
			this.skipDir = dir;
			this.skipCount = 0;
		}
		this.skipCount += Math.abs(ticks);
		if (this.skipCount < SKIP_TICKS) return 0;
		this.skipCount = 0;
		if (!this.feature(dir > 0 ? Feature.NEXT_TRACK : Feature.PREVIOUS_TRACK)) return 0;
		this.send(dir > 0 ? "media_next_track" : "media_previous_track");
		this.cooldownUntil = now + SKIP_COOLDOWN_MS;
		return dir;
	}

	/** Skips one track right away (a tap zone). False, with an alert, when the player can't skip that way. */
	skipNow(dir: -1 | 1): boolean {
		if (!this.feature(dir > 0 ? Feature.NEXT_TRACK : Feature.PREVIOUS_TRACK)) {
			this.alert();
			return false;
		}
		this.send(dir > 0 ? "media_next_track" : "media_previous_track");
		return true;
	}

	/** Forgets detents counted toward a skip (a mode switch starts the count over). */
	resetSkipCount(): void {
		this.skipCount = 0;
	}

	/** Fires a service call; any failure, sync or async, becomes an alert. */
	send(service: string, data?: Record<string, unknown>): void {
		try {
			this.deps.call(service, data).catch(() => this.alert());
		} catch {
			this.alert();
		}
	}

	/** Shows the alert, at most once per ALERT_THROTTLE_MS. */
	alert(): void {
		const now = this.deps.now();
		if (now - this.lastAlertAt < ALERT_THROTTLE_MS) return;
		this.lastAlertAt = now;
		this.deps.alert();
	}

	private playerView(entityId: string): View {
		const p = this.player;
		if (p === undefined) return messageView(CONNECTING);
		if (p === null) return messageView(NOT_FOUND, entityId);
		const gone = p.status === "unavailable" || p.status === "unknown";
		return { player: p, dimmed: gone, blocked: gone };
	}

	/** Copies HA's volume and mute into the local echo. */
	private adopt(): void {
		const p = this.player;
		if (!p) return;
		if (p.volume !== undefined) this.volumeValue = p.volume;
		this.mutedValue = p.muted;
		this.rev++;
	}

	private cancelPending(): void {
		this.volumeSendAt = null;
		this.skipCount = 0;
		this.skipDir = 0;
	}
}
