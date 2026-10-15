// The per-dial state machine (spec 6 and 7). No SDK and no timers: input reads the clock
// through `now()`, everything that expires happens in `tick(t)`, and the frame loop asks
// `urgent()` and `priority(t)` what to grant before pulling `frame(t)`.
import { FALLBACK_ACCENT } from "../art/accent";
import type { CoverResult } from "../art/cover";
import type { ConnStatus } from "../ha/connection";
import { Feature, has, type PlayerState } from "../ha/playerState";
import { buildBackdrop } from "../render/backdrop";
import { composeSingle, renderForeground, type DialUi, type Frame } from "../render/foreground";
import { RENDER_MODE } from "../render/mode";
import { mapSource, type ResolvedDialSettings } from "../settings";

/** volume_set fires this long after the last detent. */
export const VOLUME_DEBOUNCE_MS = 150;
/** After local volume input, HA-reported volume and mute are ignored this long. */
export const ADOPT_GUARD_MS = 2500;
/** The volume takeover holds this long after the last detent, then fades out. */
export const TAKEOVER_MS = 1500;
export const TAKEOVER_FADE_MS = 300;
/** Detents in one direction per track skip, and the pause after a skip. */
export const SKIP_TICKS = 4;
export const SKIP_COOLDOWN_MS = 600;
/** Idle time in tracks mode before the dial falls back to volume mode. */
export const MODE_REVERT_MS = 6000;
/** How long the firing chevron flashes in the accent. */
export const FLASH_MS = 350;
/** Marquee step per full-rate frame (spec 4.3: about 24 px/s at 10 fps); half-rate frames step double. */
export const SCROLL_STEP_PX = 2.4;

const SETUP = "Set up Spindle in Stream Deck";
const CHECK_TOKEN = "Check token";
const CONNECTING = "Connecting…";
const NOT_FOUND = "Player not found";
const RECONNECTING = "Reconnecting…";

export type Priority = "none" | "half" | "full";
export type ServiceCall = (service: string, data?: Record<string, unknown>) => Promise<void>;
export type ControllerDeps = {
	now: () => number;
	call: ServiceCall;
	alert: () => void;
	/** Defaults to RENDER_MODE; tests force "single" here. */
	renderMode?: "layered" | "single";
};

/** What the strip shows. `blocked`: input is refused with an alert (spec 7). */
type View = { player: PlayerState | null; message?: DialUi["message"]; dimmed: boolean; badge?: string; blocked: boolean };

const messageView = (headline: string, sub?: string): View => ({
	player: null,
	message: sub === undefined ? { headline } : { headline, sub },
	dimmed: false,
	blocked: true
});
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const svgUri = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

export class DialController {
	private readonly renderMode: "layered" | "single";
	private settings: ResolvedDialSettings;
	private conn: ConnStatus | null = null;
	/** Whether this connection has ever reached `connected`; decides "Connecting…" vs "Reconnecting…". */
	private everConnected = false;
	/** undefined until the entity stream first reports; null when HA has no such entity. */
	private player: PlayerState | null | undefined = undefined;

	private cover: CoverResult | null = null;
	private bgUri: string;
	private bgPending = true;
	private firstSent = false;
	/** Something the fg shows changed since the last sent frame. */
	private dirty = true;
	private lastFrame: Frame | null = null;

	/** The user's choice; `effectiveMode()` applies what the entity supports. */
	private mode: "volume" | "tracks" = "volume";
	private volume = 0;
	private muted = false;
	private offset = 0;
	private takeoverAlpha = 0;
	private flashDir: -1 | 0 | 1 = 0;

	private volumeSendAt: number | null = null;
	private guardUntil: number | null = null;
	private lastVolumeRotate: number | null = null;
	private lastTracksInput = 0;
	private skipCount = 0;
	private skipDir = 0;
	private cooldownUntil = -Infinity;
	private flashUntil = -Infinity;

	constructor(
		private readonly deps: ControllerDeps,
		settings: ResolvedDialSettings
	) {
		this.renderMode = deps.renderMode ?? RENDER_MODE;
		this.settings = settings;
		this.bgUri = buildBackdrop(null, FALLBACK_ACCENT);
	}

	updateSettings(s: ResolvedDialSettings): void {
		if (s.entityId !== this.settings.entityId) {
			this.player = undefined;
			this.offset = 0;
			this.cancelPending();
		}
		this.settings = s;
		this.dirty = true;
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
		this.dirty = true;
	}

	/** null = the entity is missing from HA. */
	setPlayer(p: PlayerState | null): void {
		const prev = this.player;
		if ((prev?.title ?? "") !== (p?.title ?? "") || (prev?.artist ?? "") !== (p?.artist ?? "")) this.offset = 0;
		this.player = p;
		if (this.guardUntil === null || this.deps.now() >= this.guardUntil) this.adopt();
		this.dirty = true;
	}

	/** null = no art, or it failed: the accent-gradient backdrop. */
	setCover(c: CoverResult | null): void {
		if ((c?.key ?? null) === (this.cover?.key ?? null)) return;
		this.cover = c;
		this.bgUri = buildBackdrop(c?.image ?? null, c?.accent ?? FALLBACK_ACCENT);
		this.bgPending = true;
		this.dirty = true;
	}

	rotate(ticks: number): void {
		if (!ticks) return;
		const p = this.inputPlayer();
		if (!p || p.status === "off") return;
		const now = this.deps.now();
		if (this.effectiveMode() === "tracks") this.rotateTracks(ticks, now);
		else this.rotateVolume(ticks, now);
	}

	press(): void {
		const p = this.inputPlayer();
		if (!p || p.status === "off" || !this.tracksAvailable()) return;
		if (this.effectiveMode() === "tracks") {
			if (this.hasVolume()) this.mode = "volume";
		} else {
			this.mode = "tracks";
			this.lastTracksInput = this.deps.now();
		}
		this.skipCount = 0;
		this.dirty = true;
	}

	tap(): void {
		if (this.inputPlayer()) this.send("media_play_pause");
	}

	tick(t: number): void {
		if (this.volumeSendAt !== null && t >= this.volumeSendAt) {
			this.volumeSendAt = null;
			this.send("volume_set", { volume_level: Math.round(this.volume) / 100 });
		}
		if (this.guardUntil !== null && t >= this.guardUntil) {
			this.guardUntil = null;
			this.adopt();
		}
		if (this.mode === "tracks" && this.hasVolume() && t - this.lastTracksInput >= MODE_REVERT_MS) {
			this.mode = "volume";
			this.dirty = true;
		}
		if (this.flashDir !== 0 && t >= this.flashUntil) {
			this.flashDir = 0;
			this.dirty = true;
		}
		if (this.lastVolumeRotate !== null) {
			const since = t - this.lastVolumeRotate;
			this.takeoverAlpha = since <= TAKEOVER_MS ? 1 : clamp(1 - (since - TAKEOVER_MS) / TAKEOVER_FADE_MS, 0, 1);
			if (since >= TAKEOVER_MS + TAKEOVER_FADE_MS) {
				// One last frame clears the overlay; the dirty flag guarantees it is sent.
				this.lastVolumeRotate = null;
				this.dirty = true;
			}
		}
	}

	/** The loop serves urgent dials first: the very first frame, or a pending bg update. */
	urgent(): boolean {
		return !this.firstSent || this.bgPending;
	}

	priority(t: number): Priority {
		if (this.dirty || !this.firstSent || this.flashDir !== 0) return "full";
		if (this.lastVolumeRotate !== null && t - this.lastVolumeRotate < TAKEOVER_MS + TAKEOVER_FADE_MS) return "full";
		if (this.lastFrame?.animating) return this.lastFrame.halfRate ? "half" : "full";
		return "none";
	}

	/** The setFeedback payload, or null when nothing needs sending. */
	frame(t: number): Record<string, string> | null {
		const pri = this.priority(t);
		if (pri === "none") return null;
		const view = this.view();
		const f = renderForeground(view.player, this.buildUi(view), this.cover?.accent ?? FALLBACK_ACCENT, t);
		let payload: Record<string, string>;
		if (this.renderMode === "single") {
			payload = { fg: svgUri(composeSingle(this.bgUri, f.svg)) };
		} else {
			payload = { fg: svgUri(f.svg) };
			if (this.bgPending) payload.bg = this.bgUri;
		}
		this.lastFrame = f;
		this.bgPending = false;
		this.firstSent = true;
		this.dirty = false;
		this.offset += pri === "full" ? SCROLL_STEP_PX : SCROLL_STEP_PX * 2;
		return payload;
	}

	/** The renderer's input as of now. */
	get ui(): DialUi {
		return this.buildUi(this.view());
	}

	private buildUi(v: View): DialUi {
		const p = v.player;
		return {
			mode: this.effectiveMode(),
			volume: this.volume,
			muted: this.muted,
			volumeDisplay: this.feature(Feature.VOLUME_SET) ? "number" : this.feature(Feature.VOLUME_STEP) ? "bar-only" : "hidden",
			takeoverAlpha: this.takeoverAlpha,
			flashDir: this.flashDir,
			offset: this.offset,
			sourceLabel: p ? mapSource(this.settings.labels, p.source, p.appName) : undefined,
			message: v.message,
			dimmed: v.dimmed,
			badge: v.badge,
			buffering: p?.status === "buffering"
		};
	}

	/** Spec 7's table, top to bottom. */
	private view(): View {
		const c = this.conn;
		if (!c || c.kind === "stopped" || !this.settings.entityId) return messageView(SETUP);
		if (c.kind === "auth_invalid") return messageView(CHECK_TOKEN);
		const reconnecting = c.kind === "unreachable" || (c.kind === "connecting" && this.everConnected);
		if (c.kind === "connecting" && !reconnecting) return messageView(CONNECTING);
		const base = this.playerView(this.settings.entityId);
		return reconnecting ? { ...base, dimmed: true, badge: RECONNECTING, blocked: true } : base;
	}

	private playerView(entityId: string): View {
		const p = this.player;
		if (p === undefined) return messageView(CONNECTING);
		if (p === null) return messageView(NOT_FOUND, entityId);
		const gone = p.status === "unavailable" || p.status === "unknown";
		return { player: p, dimmed: gone, blocked: gone };
	}

	/** The player when input is allowed; otherwise alerts and returns null. */
	private inputPlayer(): PlayerState | null {
		const v = this.view();
		if (v.blocked || !v.player) {
			this.deps.alert();
			return null;
		}
		return v.player;
	}

	private rotateVolume(ticks: number, now: number): void {
		const canSet = this.feature(Feature.VOLUME_SET);
		if (!canSet && !this.feature(Feature.VOLUME_STEP)) return;
		this.volume = clamp(this.volume + ticks * this.settings.volumeStep, 0, 100);
		if (ticks > 0) this.muted = false;
		this.guardUntil = now + ADOPT_GUARD_MS;
		this.lastVolumeRotate = now;
		this.takeoverAlpha = 1;
		this.dirty = true;
		if (canSet) {
			this.volumeSendAt = now + VOLUME_DEBOUNCE_MS;
		} else {
			for (let i = 0; i < Math.abs(ticks); i++) this.send(ticks > 0 ? "volume_up" : "volume_down");
		}
	}

	private rotateTracks(ticks: number, now: number): void {
		this.lastTracksInput = now;
		if (now < this.cooldownUntil) return;
		const dir = ticks > 0 ? 1 : -1;
		if (dir !== this.skipDir) {
			this.skipDir = dir;
			this.skipCount = 0;
		}
		this.skipCount += Math.abs(ticks);
		if (this.skipCount < SKIP_TICKS) return;
		this.skipCount = 0;
		if (!this.feature(dir > 0 ? Feature.NEXT_TRACK : Feature.PREVIOUS_TRACK)) return;
		this.send(dir > 0 ? "media_next_track" : "media_previous_track");
		this.cooldownUntil = now + SKIP_COOLDOWN_MS;
		this.flashDir = dir;
		this.flashUntil = now + FLASH_MS;
		this.dirty = true;
	}

	/** Copies HA's volume and mute into the local echo. */
	private adopt(): void {
		const p = this.player;
		if (!p) return;
		if (p.volume !== undefined) this.volume = p.volume;
		this.muted = p.muted;
		this.dirty = true;
	}

	private cancelPending(): void {
		this.volumeSendAt = null;
		this.skipCount = 0;
		this.skipDir = 0;
	}

	private feature(f: number): boolean {
		return !!this.player && has(this.player, f);
	}

	private hasVolume(): boolean {
		return this.feature(Feature.VOLUME_SET) || this.feature(Feature.VOLUME_STEP);
	}

	private tracksAvailable(): boolean {
		return this.settings.tracksMode && (this.feature(Feature.NEXT_TRACK) || this.feature(Feature.PREVIOUS_TRACK));
	}

	private effectiveMode(): "volume" | "tracks" {
		if (!this.tracksAvailable()) return "volume";
		return this.mode === "tracks" || !this.hasVolume() ? "tracks" : "volume";
	}

	/** Fires a service call; any failure, sync or async, becomes an alert on this dial. */
	private send(service: string, data?: Record<string, unknown>): void {
		try {
			this.deps.call(service, data).catch(() => this.deps.alert());
		} catch {
			this.deps.alert();
		}
	}
}
