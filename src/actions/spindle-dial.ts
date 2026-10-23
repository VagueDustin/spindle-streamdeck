import {
	action,
	SingletonAction,
	type DialDownEvent,
	type DialRotateEvent,
	type DidReceiveSettingsEvent,
	type SendToPluginEvent,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent
} from "@elgato/streamdeck";

import { DialController } from "../dial/controller";
import { errorText, type JsonValue, type SpindleHub } from "../hub";
import type { FeedbackSink } from "../loop";
import { LAYOUT_PATH } from "../render/geometry";
import { resolveDialSettings, type DialSettings, type ResolvedDialSettings } from "../settings";

type Dial = { ctl: DialController; settings: ResolvedDialSettings };

/** The Spindle dial: one DialController per visible dial, all fed by the hub's connection and frame loop. */
@action({ UUID: "com.vaguedustin.spindle.dial" })
export class SpindleDial extends SingletonAction<DialSettings> {
	private readonly dials = new Map<string, Dial>();

	constructor(private readonly hub: SpindleHub) {
		super();
	}

	override async onWillAppear(ev: WillAppearEvent<DialSettings>): Promise<void> {
		if (!ev.action.isDial()) return;
		const dialAction = ev.action;
		// Ask for the layout before the loop can send a frame; the SDK sends commands in order.
		const layout = dialAction.setFeedbackLayout(LAYOUT_PATH).catch((err: unknown) => this.hub.warn(`setFeedbackLayout failed: ${errorText(err)}`));
		this.hub.guard("willAppear", () => {
			const id = dialAction.id;
			const settings = resolveDialSettings(ev.payload.settings);
			const ctl = new DialController(
				{
					now: Date.now,
					call: (service, data) => this.hub.callService(id, service, data),
					alert: () => {
						dialAction.showAlert().catch((err: unknown) => this.hub.warn(`showAlert failed: ${errorText(err)}`));
					}
				},
				settings
			);
			this.dials.set(id, { ctl, settings });
			const sink: FeedbackSink = (payload) => dialAction.setFeedback(payload);
			const capture = this.hub.capture;
			this.hub.addSurface(id, ctl, __SPINDLE_CAPTURE__ && capture ? capture.wrap(dialAction.coordinates.column, sink) : sink);
			this.hub.attach(id, ctl, settings.entityId);
		});
		await layout;
	}

	override onWillDisappear(ev: WillDisappearEvent<DialSettings>): void {
		this.hub.guard("willDisappear", () => {
			const id = ev.action.id;
			if (!this.dials.delete(id)) return;
			this.hub.detach(id);
			this.hub.removeSurface(id);
		});
	}

	override onDialRotate(ev: DialRotateEvent<DialSettings>): void {
		this.hub.guard("dialRotate", () => this.dials.get(ev.action.id)?.ctl.rotate(ev.payload.ticks));
	}

	override onDialDown(ev: DialDownEvent<DialSettings>): void {
		this.hub.guard("dialDown", () => this.dials.get(ev.action.id)?.ctl.press());
	}

	override onTouchTap(ev: TouchTapEvent<DialSettings>): void {
		this.hub.guard("touchTap", () => this.dials.get(ev.action.id)?.ctl.tap(ev.payload.tapPos[0]));
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<DialSettings>): void {
		this.hub.guard("didReceiveSettings", () => {
			const id = ev.action.id;
			const d = this.dials.get(id);
			if (!d) return;
			const next = resolveDialSettings(ev.payload.settings);
			const entityChanged = next.entityId !== d.settings.entityId;
			d.settings = next;
			// Unbind first so the old entity's updates stop before the controller forgets it.
			if (entityChanged) this.hub.setEntity(id, null);
			d.ctl.updateSettings(next);
			if (entityChanged) this.hub.setEntity(id, next.entityId);
		});
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, DialSettings>): Promise<void> {
		await this.hub.onPiRequest(ev.action.id, ev.payload);
	}
}
