// The Wide surface: one PlayerSession drawn across two adjacent strip segments. The left dial turns the
// volume and its press mutes; the right dial skips tracks and its press plays or pauses; a tap on
// either half plays or pauses. Both halves come out of one `frame(t)` so the loop sends them together.
import { FALLBACK_ACCENT } from "../art/accent";
import type { CoverResult } from "../art/cover";
import { FLASH_MS, svgUri, TAKEOVER_FADE_MS, TAKEOVER_MS, tapZone, type ControllerDeps, type Priority } from "../dial/controller";
import type { ConnStatus } from "../ha/connection";
import { Feature, type PlayerState } from "../ha/playerState";
import { PlayerSession, type SessionSettings } from "../player/session";
import { STRIP_W } from "../render/geometry";
import { buildTakeoverPlate, buildWideBackdrop } from "../render/backdrop";
import { composeSingle, type Frame } from "../render/foreground";
import { RENDER_MODE } from "../render/mode";
import { renderWide, type WideUi } from "../render/wide";
import { mapSource } from "../settings";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Marquee step per frame. A pair gets a frame every other heartbeat (5 fps), and long titles across
 * 400 px felt slow at the dial's 24 px/s, so the Wide marquee runs at 40 px/s.
 */
export const WIDE_SCROLL_STEP_PX = 8;

export type WideSettings = SessionSettings & { tapToSkip: boolean };

export class WideController {
	readonly session: PlayerSession;
	private readonly renderMode: "layered" | "single";
	private bg: [string, string];
	private plateUri: string;
	private bgPending = true;
	private coverRev = 0;
	private firstSent = false;
	private dirty = true;
	private seenRev = -1;
	private lastFrame: Frame | null = null;
	/** Title and artist as of the last frame; a change restarts the marquee. */
	private textKey = "";

	private offset = 0;
	private takeoverAlpha = 0;
	private flashDir: -1 | 0 | 1 = 0;
	private flashUntil = -Infinity;
	private lastVolumeRotate: number | null = null;

	private tapToSkip: boolean;

	constructor(
		private readonly deps: ControllerDeps,
		settings: WideSettings
	) {
		this.tapToSkip = settings.tapToSkip;
		this.renderMode = deps.renderMode ?? RENDER_MODE;
		this.session = new PlayerSession(deps, settings);
		this.bg = buildWideBackdrop(null, FALLBACK_ACCENT);
		this.plateUri = buildTakeoverPlate(null, FALLBACK_ACCENT);
	}

	updateSettings(s: WideSettings): void {
		this.tapToSkip = s.tapToSkip;
		if (s.entityId !== this.session.settings.entityId) this.offset = 0;
		this.session.updateSettings(s);
	}

	setConnStatus(s: ConnStatus | null): void {
		this.session.setConnStatus(s);
	}

	setPlayer(p: PlayerState | null): void {
		this.session.setPlayer(p);
	}

	get coverKey(): string | null {
		return this.session.coverKey;
	}

	setCover(c: CoverResult | null): void {
		this.session.setCover(c);
	}

	/** Left dial turn: the volume, with the takeover over the left half. */
	rotateVolume(ticks: number): void {
		if (!ticks) return;
		const p = this.session.inputPlayer();
		if (!p || p.status === "off") return;
		const now = this.deps.now();
		if (this.session.stepVolume(ticks, now)) {
			this.lastVolumeRotate = now;
			this.takeoverAlpha = 1;
		}
	}

	/** Left dial press: mute toggle. */
	pressMute(): void {
		const p = this.session.inputPlayer();
		if (!p || p.status === "off") return;
		this.session.toggleMute(this.deps.now());
	}

	/** Right dial turn: track skips, flashing the chevron that fired. */
	rotateSkip(ticks: number): void {
		if (!ticks) return;
		const p = this.session.inputPlayer();
		if (!p || p.status === "off") return;
		const now = this.deps.now();
		const fired = this.session.skipTicks(ticks, now);
		if (fired === 0) return;
		this.flashDir = fired;
		this.flashUntil = now + FLASH_MS;
		this.dirty = true;
	}

	/** Right dial press. */
	playPause(): void {
		if (this.session.inputPlayer()) this.session.send("media_play_pause");
	}

	/**
	 * A tap at `x` (0–200) on one half. With tap zones on, the widget's outer thirds (measured across
	 * all 400 px) skip back and forward, flashing that chevron; the middle plays or pauses.
	 */
	tap(side: "left" | "right", x?: number): void {
		const p = this.session.inputPlayer();
		if (!p) return;
		const zone = this.tapToSkip && x !== undefined ? tapZone(x + (side === "right" ? STRIP_W : 0), STRIP_W * 2) : 0;
		if (zone === 0 || p.status === "off") {
			this.session.send("media_play_pause");
			return;
		}
		if (!this.session.skipNow(zone)) return;
		this.flashDir = zone;
		this.flashUntil = this.deps.now() + FLASH_MS;
		this.dirty = true;
	}

	tick(t: number): void {
		this.session.tick(t);
		if (this.flashDir !== 0 && t >= this.flashUntil) {
			this.flashDir = 0;
			this.dirty = true;
		}
		if (this.lastVolumeRotate !== null) {
			const since = t - this.lastVolumeRotate;
			this.takeoverAlpha = since <= TAKEOVER_MS ? 1 : clamp(1 - (since - TAKEOVER_MS) / TAKEOVER_FADE_MS, 0, 1);
			if (since >= TAKEOVER_MS + TAKEOVER_FADE_MS) {
				this.lastVolumeRotate = null;
				this.dirty = true;
			}
		}
	}

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

	/** The left and right setFeedback payloads, or null when nothing needs sending. */
	frame(t: number): Array<Record<string, string>> | null {
		const pri = this.priority(t);
		if (pri === "none") return null;
		const ui = this.ui;
		const { halves } = renderWide(this.session.view().player, ui, this.session.cover?.accent ?? FALLBACK_ACCENT, t);
		const payloads = halves.map((f, i) => {
			if (this.renderMode === "single") return { fg: svgUri(composeSingle(this.bg[i], f.svg)) };
			const payload: Record<string, string> = { fg: svgUri(f.svg) };
			if (this.bgPending) payload.bg = this.bg[i];
			return payload;
		});
		this.lastFrame = halves[0];
		this.bgPending = false;
		this.firstSent = true;
		this.dirty = false;
		this.seenRev = this.session.rev;
		this.offset += WIDE_SCROLL_STEP_PX;
		return payloads;
	}

	get ui(): WideUi {
		this.syncCover();
		const s = this.session;
		const v = s.view();
		const p = v.player;
		const key = `${p?.title ?? ""}\u0000${p?.artist ?? ""}`;
		if (key !== this.textKey) {
			this.textKey = key;
			this.offset = 0;
		}
		return {
			volume: s.volume,
			muted: s.muted,
			volumeDisplay: s.feature(Feature.VOLUME_SET) ? "number" : s.feature(Feature.VOLUME_STEP) ? "bar-only" : "hidden",
			takeoverAlpha: this.takeoverAlpha,
			flashDir: this.flashDir,
			offset: this.offset,
			sourceLabel: p ? mapSource(s.settings.labels, p.source, p.appName) : undefined,
			message: v.message,
			dimmed: v.dimmed,
			badge: v.badge,
			buffering: p?.status === "buffering",
			plate: this.plateUri
		};
	}

	private syncCover(): void {
		if (this.coverRev === this.session.coverRev) return;
		this.coverRev = this.session.coverRev;
		const c = this.session.cover;
		this.bg = buildWideBackdrop(c?.image ?? null, c?.accent ?? FALLBACK_ACCENT);
		this.plateUri = buildTakeoverPlate(c?.image ?? null, c?.accent ?? FALLBACK_ACCENT);
		this.bgPending = true;
	}
}
