// The key surfaces: Cover and Transport. Each draws one PlayerSession as a 144×144 SVG and sends it
// with setImage only when the picture actually changed (HA reports far more often than a key changes).
// No SDK and no timers, like the dial: input reads `now()`, holds repeat in `tick(t)`.
import { FALLBACK_ACCENT } from "../art/accent";
import type { CoverResult } from "../art/cover";
import { coverFit, encodePng } from "../art/image";
import { SCROLL_STEP_PX, svgUri, type ControllerDeps, type Priority } from "../dial/controller";
import type { ConnStatus } from "../ha/connection";
import { Feature, type PlayerState } from "../ha/playerState";
import { PlayerSession } from "../player/session";
import { KEY, renderCoverKey, renderTransportKey, type KeyFrame } from "../render/key";
import type { CoverDisplay, ResolvedCoverKeySettings, ResolvedTransportKeySettings, TransportFunction } from "../settings";

/** Holding a volume key repeats the step after this long... */
export const HOLD_DELAY_MS = 400;
/** ...and then this often. */
export const HOLD_REPEAT_MS = 200;
/** The key marquee steps this far per (half-rate) frame: keys are drawn at 2× their 72 px. */
const KEY_SCROLL_PX = SCROLL_STEP_PX * 4;

type KeyDeps = Omit<ControllerDeps, "renderMode">;

/** What both key surfaces share: binding passthroughs and send-only-on-change. */
abstract class KeySurface {
	readonly session: PlayerSession;
	private lastSvg = "";
	private seenRev = -1;
	private animating = false;

	constructor(
		protected readonly deps: KeyDeps,
		settings: ResolvedCoverKeySettings | ResolvedTransportKeySettings
	) {
		this.session = new PlayerSession(deps, settings);
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

	tick(t: number): void {
		this.session.tick(t);
	}

	/** Keys never need to jump the queue: a key image is a single small send. */
	urgent(): boolean {
		return false;
	}

	priority(): Priority {
		if (this.session.rev !== this.seenRev) return "full";
		return this.animating ? "half" : "none";
	}

	/** `{ image }` for setImage, or null when the picture is unchanged. */
	frame(t: number): Record<string, string> | null {
		if (this.priority() === "none") return null;
		this.seenRev = this.session.rev;
		const f = this.render(t);
		this.animating = f.animating;
		if (f.svg === this.lastSvg) return null;
		this.lastSvg = f.svg;
		return { image: svgUri(f.svg) };
	}

	/** Forces the next frame out, e.g. after the settings changed what the key draws. */
	protected invalidate(): void {
		this.seenRev = -1;
	}

	protected abstract render(t: number): KeyFrame;
}

export class CoverKeyController extends KeySurface {
	private display: CoverDisplay;
	private art: string | null = null;
	private artRev = 0;
	private offset = 0;
	private textKey = "";

	constructor(deps: KeyDeps, settings: ResolvedCoverKeySettings) {
		super(deps, settings);
		this.display = settings.display;
	}

	updateSettings(s: ResolvedCoverKeySettings): void {
		this.display = s.display;
		this.session.updateSettings(s);
		this.invalidate();
	}

	/** Press: play/pause. */
	press(): void {
		if (this.session.inputPlayer()) this.session.send("media_play_pause");
	}

	protected render(): KeyFrame {
		this.syncArt();
		const view = this.session.view();
		const key = `${view.player?.title ?? ""}\u0000${view.player?.friendlyName ?? ""}`;
		if (key !== this.textKey) {
			this.textKey = key;
			this.offset = 0;
		}
		const f = renderCoverKey({
			view,
			art: this.art,
			accent: this.session.cover?.accent ?? FALLBACK_ACCENT,
			display: this.display,
			offset: this.offset
		});
		if (f.animating) this.offset += KEY_SCROLL_PX;
		return f;
	}

	private syncArt(): void {
		if (this.artRev === this.session.coverRev) return;
		this.artRev = this.session.coverRev;
		const image = this.session.cover?.image;
		this.art = image ? `data:image/png;base64,${Buffer.from(encodePng(coverFit(image, KEY, KEY))).toString("base64")}` : null;
	}
}

export class TransportKeyController extends KeySurface {
	private fn: TransportFunction;
	private holdSince: number | null = null;
	private lastRepeat = 0;

	constructor(deps: KeyDeps, settings: ResolvedTransportKeySettings) {
		super(deps, settings);
		this.fn = settings.fn;
	}

	updateSettings(s: ResolvedTransportKeySettings): void {
		this.fn = s.fn;
		this.holdSince = null;
		this.session.updateSettings(s);
		this.invalidate();
	}

	press(): void {
		const p = this.session.inputPlayer();
		if (!p) return;
		const now = this.deps.now();
		// Like the dial's tap, play/pause still goes out to a player that is off: it may wake it.
		if (this.fn === "playpause") return this.session.send("media_play_pause");
		if (p.status === "off") return;
		if (!this.supported()) return this.session.alert();
		switch (this.fn) {
			case "next":
				return this.session.send("media_next_track");
			case "previous":
				return this.session.send("media_previous_track");
			case "mute":
				this.session.toggleMute(now);
				return;
			case "volume_up":
			case "volume_down":
				this.session.stepVolume(this.direction(), now);
				this.holdSince = now;
				this.lastRepeat = now;
				return;
		}
	}

	release(): void {
		this.holdSince = null;
	}

	override tick(t: number): void {
		super.tick(t);
		if (this.holdSince === null || t - this.holdSince < HOLD_DELAY_MS || t - this.lastRepeat < HOLD_REPEAT_MS) return;
		const p = this.session.view().player;
		if (this.session.view().blocked || !p || p.status === "off") {
			this.holdSince = null;
			return;
		}
		this.lastRepeat = t;
		this.session.stepVolume(this.direction(), t);
	}

	protected render(): KeyFrame {
		const s = this.session;
		const p = s.view().player;
		return renderTransportKey({
			view: s.view(),
			fn: this.fn,
			accent: s.cover?.accent ?? FALLBACK_ACCENT,
			supported: this.supported(),
			playing: p?.status === "playing" || p?.status === "buffering",
			muted: s.muted,
			volume: s.volume,
			showVolume: s.feature(Feature.VOLUME_SET)
		});
	}

	private direction(): 1 | -1 {
		return this.fn === "volume_down" ? -1 : 1;
	}

	private supported(): boolean {
		const s = this.session;
		switch (this.fn) {
			case "playpause":
				return true;
			case "next":
				return s.feature(Feature.NEXT_TRACK);
			case "previous":
				return s.feature(Feature.PREVIOUS_TRACK);
			case "mute":
				return s.feature(Feature.VOLUME_MUTE);
			case "volume_up":
			case "volume_down":
				return s.hasVolume();
		}
	}
}
