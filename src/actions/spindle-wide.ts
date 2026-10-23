import streamDeck, {
	action,
	SingletonAction,
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	type DidReceiveSettingsEvent,
	type PropertyInspectorDidAppearEvent,
	type SendToPluginEvent,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent
} from "@elgato/streamdeck";

import { errorText, isGetEvent, type JsonValue, type SpindleHub } from "../hub";
import type { FeedbackSink } from "../loop";
import { LAYOUT_PATH } from "../render/geometry";
import { resolveWideSettings, type WideSettings } from "../settings";
import { WideController } from "../wide/controller";
import { pairKey, pairWideDials, type WidePair, type WideSlot } from "../wide/pairing";
import { UNPAIRED_GRACE_MS, UnpairedWide } from "../wide/unpaired";

type Slot = { slot: WideSlot; action: DialAction<WideSettings>; settings: WideSettings };
type Pair = { pair: WidePair; ctl: WideController };
export type WideRole = "left" | "right" | "unpaired";

/**
 * Now Playing (Wide): two adjacent Wide dials drawn as one 400×100 widget. Pairs are recomputed on every
 * appear and disappear; an unchanged pair keeps its controller. The left dial owns the settings.
 */
@action({ UUID: "com.vaguedustin.spindle.wide" })
export class SpindleWide extends SingletonAction<WideSettings> {
	private readonly slots = new Map<string, Slot>();
	private readonly pairs = new Map<string, Pair>();
	private readonly unpaired = new Set<string>();

	constructor(private readonly hub: SpindleHub) {
		super();
	}

	override async onWillAppear(ev: WillAppearEvent<WideSettings>): Promise<void> {
		if (!ev.action.isDial()) return;
		const dialAction = ev.action;
		const layout = dialAction.setFeedbackLayout(LAYOUT_PATH).catch((err: unknown) => this.hub.warn(`setFeedbackLayout failed: ${errorText(err)}`));
		this.hub.guard("wideWillAppear", () => {
			const id = dialAction.id;
			this.slots.set(id, {
				slot: { id, device: dialAction.device.id, column: dialAction.coordinates.column },
				action: dialAction,
				settings: ev.payload.settings
			});
			this.repair();
		});
		await layout;
	}

	override onWillDisappear(ev: WillDisappearEvent<WideSettings>): void {
		this.hub.guard("wideWillDisappear", () => {
			if (!this.slots.delete(ev.action.id)) return;
			this.repair();
		});
	}

	override onDialRotate(ev: DialRotateEvent<WideSettings>): void {
		this.hub.guard("wideRotate", () => {
			const at = this.find(ev.action.id);
			if (!at) return this.alert(ev.action.id);
			if (at.side === "left") at.ctl.rotateVolume(ev.payload.ticks);
			else at.ctl.rotateSkip(ev.payload.ticks);
		});
	}

	override onDialDown(ev: DialDownEvent<WideSettings>): void {
		this.hub.guard("wideDialDown", () => {
			const at = this.find(ev.action.id);
			if (!at) return this.alert(ev.action.id);
			if (at.side === "left") at.ctl.pressMute();
			else at.ctl.playPause();
		});
	}

	override onTouchTap(ev: TouchTapEvent<WideSettings>): void {
		this.hub.guard("wideTouchTap", () => {
			const at = this.find(ev.action.id);
			if (!at) return this.alert(ev.action.id);
			at.ctl.tap(at.side, ev.payload.tapPos[0]);
		});
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<WideSettings>): void {
		this.hub.guard("wideDidReceiveSettings", () => {
			const id = ev.action.id;
			const s = this.slots.get(id);
			if (!s) return;
			s.settings = ev.payload.settings;
			const at = this.find(id);
			if (at?.side !== "left") return;
			const next = resolveWideSettings(s.settings);
			const entityChanged = next.entityId !== at.ctl.session.settings.entityId;
			if (entityChanged) this.hub.setEntity(at.key, null);
			at.ctl.updateSettings(next);
			if (entityChanged) this.hub.setEntity(at.key, next.entityId);
		});
	}

	override onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent<WideSettings>): void {
		this.hub.guard("widePiAppear", () => this.sendRole(ev.action.id));
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, WideSettings>): Promise<void> {
		if (isGetEvent(ev.payload, "getRole")) {
			this.hub.guard("wideGetRole", () => this.sendRole(ev.action.id));
			return;
		}
		await this.hub.onPiRequest(ev.action.id, ev.payload);
	}

	/**
	 * Recomputes the pairs. New pairs and messages are built before stale ones are torn down, so the
	 * shared connection is never released in between.
	 */
	private repair(): void {
		const { pairs, unpaired } = pairWideDials([...this.slots.values()].map((s) => s.slot));
		const wanted = new Map(pairs.map((p) => [pairKey(p), p]));
		const lone = new Set(unpaired.map((s) => s.id));

		for (const [key, pair] of wanted) {
			if (this.pairs.has(key)) continue;
			this.pairs.set(key, { pair, ctl: this.buildPair(key, pair) });
		}
		for (const id of lone) {
			if (this.unpaired.has(id)) continue;
			const s = this.slots.get(id);
			if (!s) continue;
			this.unpaired.add(id);
			this.hub.addSurface(id, new UnpairedWide(Date.now() + UNPAIRED_GRACE_MS), this.sink(s));
		}

		for (const [key] of this.pairs) {
			if (wanted.has(key)) continue;
			this.hub.detach(key);
			this.hub.removeSurface(key);
			this.pairs.delete(key);
		}
		for (const id of this.unpaired) {
			if (lone.has(id)) continue;
			this.hub.removeSurface(id);
			this.unpaired.delete(id);
		}

		const open = streamDeck.ui.action;
		if (open && this.slots.has(open.id)) this.sendRole(open.id);
	}

	private buildPair(key: string, pair: WidePair): WideController {
		const left = this.slots.get(pair.left.id)!;
		const right = this.slots.get(pair.right.id)!;
		const settings = resolveWideSettings(left.settings);
		const ctl = new WideController(
			{
				now: Date.now,
				call: (service, data) => this.hub.callService(key, service, data),
				// The alert shows on both halves: the pair is one widget.
				alert: () => {
					for (const a of [left.action, right.action]) a.showAlert().catch((err: unknown) => this.hub.warn(`showAlert failed: ${errorText(err)}`));
				}
			},
			settings
		);
		this.hub.addGroup(key, ctl, [this.sink(left), this.sink(right)]);
		this.hub.attach(key, ctl, settings.entityId, pair.left.id);
		return ctl;
	}

	/** The half's setFeedback, recorded under its column in a capture build. */
	private sink(s: Slot): FeedbackSink {
		const sink: FeedbackSink = (payload) => s.action.setFeedback(payload);
		const capture = this.hub.capture;
		return __SPINDLE_CAPTURE__ && capture ? capture.wrap(s.slot.column, sink) : sink;
	}

	private find(id: string): { key: string; ctl: WideController; side: "left" | "right" } | null {
		for (const [key, p] of this.pairs) {
			if (p.pair.left.id === id) return { key, ctl: p.ctl, side: "left" };
			if (p.pair.right.id === id) return { key, ctl: p.ctl, side: "right" };
		}
		return null;
	}

	private role(id: string): WideRole {
		return this.find(id)?.side ?? "unpaired";
	}

	private sendRole(id: string): void {
		this.hub.sendToPI({ event: "wideRole", role: this.role(id) });
	}

	private alert(id: string): void {
		this.slots
			.get(id)
			?.action.showAlert()
			.catch((err: unknown) => this.hub.warn(`showAlert failed: ${errorText(err)}`));
	}
}
