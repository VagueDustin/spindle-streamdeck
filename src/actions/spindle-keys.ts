import {
	action,
	SingletonAction,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type KeyUpEvent,
	type SendToPluginEvent,
	type WillAppearEvent,
	type WillDisappearEvent
} from "@elgato/streamdeck";

import { keySlot } from "../capture";
import { errorText, type JsonValue, type SpindleHub } from "../hub";
import { CoverKeyController, TransportKeyController } from "../keys/controllers";
import type { FeedbackSink } from "../loop";
import {
	resolveCoverKeySettings,
	resolveTransportKeySettings,
	type CoverKeySettings,
	type ResolvedCoverKeySettings,
	type ResolvedTransportKeySettings,
	type TransportKeySettings
} from "../settings";

type Resolved = ResolvedCoverKeySettings | ResolvedTransportKeySettings;
type Ctl<R extends Resolved> = (CoverKeyController | TransportKeyController) & { updateSettings(s: R): void; press(): void };

/** The shared shape of both key actions: one controller per visible key, fed by the hub. */
abstract class SpindleKey<S extends CoverKeySettings | TransportKeySettings, R extends Resolved, C extends Ctl<R>> extends SingletonAction<S> {
	private readonly keys = new Map<string, C>();

	constructor(protected readonly hub: SpindleHub) {
		super();
	}

	protected abstract resolve(s: S): R;
	protected abstract create(deps: ConstructorParameters<typeof CoverKeyController>[0], settings: R): C;

	override onWillAppear(ev: WillAppearEvent<S>): void {
		if (!ev.action.isKey()) return;
		const keyAction: KeyAction<S> = ev.action;
		this.hub.guard("keyWillAppear", () => {
			const id = keyAction.id;
			const settings = this.resolve(ev.payload.settings);
			const ctl = this.create(
				{
					now: Date.now,
					call: (service, data) => this.hub.callService(id, service, data),
					alert: () => {
						keyAction.showAlert().catch((err: unknown) => this.hub.warn(`showAlert failed: ${errorText(err)}`));
					}
				},
				settings
			);
			this.keys.set(id, ctl);
			const sink: FeedbackSink = (payload) => keyAction.setImage(payload.image);
			const capture = this.hub.capture;
			const at = keyAction.coordinates;
			this.hub.addSurface(id, ctl, __SPINDLE_CAPTURE__ && capture && at ? capture.wrap(keySlot(at.row, at.column), sink) : sink);
			this.hub.attach(id, ctl, settings.entityId);
		});
	}

	override onWillDisappear(ev: WillDisappearEvent<S>): void {
		this.hub.guard("keyWillDisappear", () => {
			const id = ev.action.id;
			if (!this.keys.delete(id)) return;
			this.hub.detach(id);
			this.hub.removeSurface(id);
		});
	}

	override onKeyDown(ev: KeyDownEvent<S>): void {
		this.hub.guard("keyDown", () => this.keys.get(ev.action.id)?.press());
	}

	override onKeyUp(ev: KeyUpEvent<S>): void {
		this.hub.guard("keyUp", () => {
			const ctl = this.keys.get(ev.action.id);
			if (ctl instanceof TransportKeyController) ctl.release();
		});
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<S>): void {
		this.hub.guard("keyDidReceiveSettings", () => {
			const id = ev.action.id;
			const ctl = this.keys.get(id);
			if (!ctl) return;
			const next = this.resolve(ev.payload.settings);
			const entityChanged = next.entityId !== ctl.session.settings.entityId;
			if (entityChanged) this.hub.setEntity(id, null);
			ctl.updateSettings(next);
			if (entityChanged) this.hub.setEntity(id, next.entityId);
		});
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, S>): Promise<void> {
		await this.hub.onPiRequest(ev.action.id, ev.payload);
	}
}

/** Cover: the now-playing art on a key; press plays or pauses. */
@action({ UUID: "com.vaguedustin.spindle.cover" })
export class SpindleCover extends SpindleKey<CoverKeySettings, ResolvedCoverKeySettings, CoverKeyController> {
	protected resolve(s: CoverKeySettings): ResolvedCoverKeySettings {
		return resolveCoverKeySettings(s);
	}

	protected create(deps: ConstructorParameters<typeof CoverKeyController>[0], settings: ResolvedCoverKeySettings): CoverKeyController {
		return new CoverKeyController(deps, settings);
	}
}

/** Transport: one player function per key, with its icon showing the live state. */
@action({ UUID: "com.vaguedustin.spindle.transport" })
export class SpindleTransport extends SpindleKey<TransportKeySettings, ResolvedTransportKeySettings, TransportKeyController> {
	protected resolve(s: TransportKeySettings): ResolvedTransportKeySettings {
		return resolveTransportKeySettings(s);
	}

	protected create(deps: ConstructorParameters<typeof TransportKeyController>[0], settings: ResolvedTransportKeySettings): TransportKeyController {
		return new TransportKeyController(deps, settings);
	}
}
