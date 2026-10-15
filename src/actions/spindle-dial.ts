import { action, SingletonAction, type WillAppearEvent } from "@elgato/streamdeck";

import { LAYOUT_PATH } from "../render/geometry";

@action({ UUID: "com.vaguedustin.spindle.dial" })
export class SpindleDial extends SingletonAction {
	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		if (ev.action.isDial()) {
			await ev.action.setFeedbackLayout(LAYOUT_PATH);
		}
	}
}
