// The dial surface: draws one PlayerSession on a 200×100 strip segment and owns what only the dial
// has (volume/tracks mode, the volume takeover, the skip flash and the marquee). No SDK and no
// timers: input reads the clock through `now()`, everything that expires happens in `tick(t)`, and
// the frame loop asks `urgent()` and `priority(t)` what to grant before pulling `frame(t)`.
import { FALLBACK_ACCENT } from "../art/accent";
import type { CoverResult } from "../art/cover";
import type { ConnStatus } from "../ha/connection";
import { Feature, type PlayerState } from "../ha/playerState";
import { PlayerSession, type ServiceCall } from "../player/session";
import { buildBackdrop, buildTakeoverPlate } from "../render/backdrop";
import { composeSingle, renderForeground, type DialUi, type Frame } from "../render/foreground";
import { STRIP_W } from "../render/geometry";
import { RENDER_MODE } from "../render/mode";
import { mapSource, type ResolvedDialSettings } from "../settings";

export {
	ADOPT_GUARD_MS,
	ALERT_THROTTLE_MS,
	SKIP_COOLDOWN_MS,
	SKIP_TICKS,
	VOLUME_DEBOUNCE_MS,
	type ServiceCall
} from "../player/session";

/** The volume takeover holds this long after the last detent, then fades out. */
export const TAKEOVER_MS = 1500;
export const TAKEOVER_FADE_MS = 300;
/** Idle time in tracks mode before the dial falls back to volume mode. */
export const MODE_REVERT_MS = 6000;
/** How long the firing chevron flashes in the accent. */
export const FLASH_MS = 350;
/** Marquee step per full-rate frame (about 24 px/s at 10 fps); half-rate frames step double. */
export const SCROLL_STEP_PX = 2.4;

export type Priority = "none" | "half" | "full";

/**
 * Which tap zone `x` falls in on a strip `width` wide: the left third skips back, the right third
 * forward, the middle plays or pauses.
 */
export function tapZone(x: number, width: number): -1 | 0 | 1 {
	if (x < width / 3) return -1;
	if (x >= (width * 2) / 3) return 1;
	return 0;
}
export type ControllerDeps = {
	now: () => number;
	call: ServiceCall;
	alert: () => void;
	/** Defaults to RENDER_MODE; tests force "single" here. */
	renderMode?: "layered" | "single";
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const svgUri = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

export class DialController {
	readonly session: PlayerSession;
	private readonly renderMode: "layered" | "single";
	private settings: ResolvedDialSettings;

	private bgUri: string;
	/** The takeover plate, built with the backdrop; only takeover frames embed it. */
	private plateUri: string;
	private bgPending = true;
	/** The session's `coverRev` the backdrop was built from. */
	private coverRev = 0;
	private firstSent = false;
	/** Something only the dial shows changed since the last sent frame. */
	private dirty = true;
	/** The session's `rev` as of the last sent frame. */
	private seenRev = -1;
	private lastFrame: Frame | null = null;

	/** The user's choice; `effectiveMode()` applies what the entity supports. */
	private mode: "volume" | "tracks" = "volume";
	private offset = 0;
	private takeoverAlpha = 0;
	private flashDir: -1 | 0 | 1 = 0;

	private lastVolumeRotate: number | null = null;
	private lastTracksInput = 0;
	private flashUntil = -Infinity;

	constructor(
		private readonly deps: ControllerDeps,
		settings: ResolvedDialSettings
	) {
		this.renderMode = deps.renderMode ?? RENDER_MODE;
		this.settings = settings;
		this.session = new PlayerSession(deps, settings);
		this.bgUri = buildBackdrop(null, FALLBACK_ACCENT);
		this.plateUri = buildTakeoverPlate(null, FALLBACK_ACCENT);
	}

	updateSettings(s: ResolvedDialSettings): void {
		if (s.entityId !== this.settings.entityId) this.offset = 0;
		this.settings = s;
		this.session.updateSettings(s);
		this.dirty = true;
	}

	/** null = not configured (no URL or token). */
	setConnStatus(s: ConnStatus | null): void {
		this.session.setConnStatus(s);
	}

	/** null = the entity is missing from HA. */
	setPlayer(p: PlayerState | null): void {
		const prev = this.session.latestPlayer;
		if ((prev?.title ?? "") !== (p?.title ?? "") || (prev?.artist ?? "") !== (p?.artist ?? "")) this.offset = 0;
		this.session.setPlayer(p);
	}

	/** The shown cover's `coverKey`; null while the accent-gradient backdrop shows. */
	get coverKey(): string | null {
		return this.session.coverKey;
	}

	/** null = no art, or it failed: the accent-gradient backdrop. */
	setCover(c: CoverResult | null): void {
		this.session.setCover(c);
		this.syncCover();
	}

	rotate(ticks: number): void {
		if (!ticks) return;
		const p = this.session.inputPlayer();
		if (!p || p.status === "off") return;
		const now = this.deps.now();
		if (this.effectiveMode() === "tracks") this.rotateTracks(ticks, now);
		else if (this.session.stepVolume(ticks, now)) {
			this.lastVolumeRotate = now;
			this.takeoverAlpha = 1;
		}
	}

	press(): void {
		const p = this.session.inputPlayer();
		if (!p || p.status === "off" || !this.tracksAvailable()) return;
		if (this.effectiveMode() === "tracks") {
			if (this.session.hasVolume()) this.mode = "volume";
		} else {
			this.mode = "tracks";
			this.lastTracksInput = this.deps.now();
		}
		this.session.resetSkipCount();
		this.dirty = true;
	}

	/** A tap on the strip at `x` (0–200); with tap zones on, the edges skip tracks. */
	tap(x?: number): void {
		const p = this.session.inputPlayer();
		if (!p) return;
		const zone = this.settings.tapToSkip && x !== undefined ? tapZone(x, STRIP_W) : 0;
		if (zone !== 0 && p.status !== "off") this.session.skipNow(zone);
		else this.session.send("media_play_pause");
	}

	tick(t: number): void {
		this.session.tick(t);
		if (this.mode === "tracks" && this.session.hasVolume() && t - this.lastTracksInput >= MODE_REVERT_MS) {
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
		this.syncCover();
		return !this.firstSent || this.bgPending;
	}

	priority(t: number): Priority {
		if (this.dirty || this.session.rev !== this.seenRev || !this.firstSent || this.flashDir !== 0) return "full";
		if (this.lastVolumeRotate !== null && t - this.lastVolumeRotate < TAKEOVER_MS + TAKEOVER_FADE_MS) return "full";
		if (this.lastFrame?.animating) return this.lastFrame.halfRate ? "half" : "full";
		return "none";
	}

	/** The setFeedback payload, or null when nothing needs sending. */
	frame(t: number): Record<string, string> | null {
		const pri = this.priority(t);
		if (pri === "none") return null;
		const ui = this.ui;
		const f = renderForeground(this.session.view().player, ui, this.session.cover?.accent ?? FALLBACK_ACCENT, t);
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
		this.seenRev = this.session.rev;
		this.offset += pri === "full" ? SCROLL_STEP_PX : SCROLL_STEP_PX * 2;
		return payload;
	}

	/** The renderer's input as of now. */
	get ui(): DialUi {
		this.syncCover();
		const s = this.session;
		const v = s.view();
		const p = v.player;
		return {
			mode: this.effectiveMode(),
			volume: s.volume,
			muted: s.muted,
			volumeDisplay: s.feature(Feature.VOLUME_SET) ? "number" : s.feature(Feature.VOLUME_STEP) ? "bar-only" : "hidden",
			takeoverAlpha: this.takeoverAlpha,
			flashDir: this.flashDir,
			offset: this.offset,
			sourceLabel: p ? mapSource(this.settings.labels, p.source, p.appName) : undefined,
			message: v.message,
			dimmed: v.dimmed,
			badge: v.badge,
			buffering: p?.status === "buffering",
			plate: this.plateUri
		};
	}

	/** Rebuilds the backdrop and plate when the session's cover changed. */
	private syncCover(): void {
		if (this.coverRev === this.session.coverRev) return;
		this.coverRev = this.session.coverRev;
		const c = this.session.cover;
		this.bgUri = buildBackdrop(c?.image ?? null, c?.accent ?? FALLBACK_ACCENT);
		this.plateUri = buildTakeoverPlate(c?.image ?? null, c?.accent ?? FALLBACK_ACCENT);
		this.bgPending = true;
	}

	private rotateTracks(ticks: number, now: number): void {
		this.lastTracksInput = now;
		const fired = this.session.skipTicks(ticks, now);
		if (fired === 0) return;
		this.flashDir = fired;
		this.flashUntil = now + FLASH_MS;
		this.dirty = true;
	}

	private tracksAvailable(): boolean {
		return this.settings.tracksMode && (this.session.feature(Feature.NEXT_TRACK) || this.session.feature(Feature.PREVIOUS_TRACK));
	}

	private effectiveMode(): "volume" | "tracks" {
		if (!this.tracksAvailable()) return "volume";
		return this.mode === "tracks" || !this.session.hasVolume() ? "tracks" : "volume";
	}
}
