import streamDeck from "@elgato/streamdeck";

import { SpindleDial } from "./actions/spindle-dial";
import { setConnectionLogger } from "./ha/connection";
import type { GlobalSettings } from "./settings";

/**
 * sdpi-components saves the URL and token fields on every keystroke. Waiting for typing to pause
 * keeps a half-typed URL or token from opening connections (a half-typed token would count toward
 * HA's IP ban as a failed login).
 */
const GLOBAL_SETTINGS_SETTLE_MS = 800;

// Before any connection exists: every HA connection logs through this (redacted) scope.
setConnectionLogger(streamDeck.logger.createScope("ha"));
streamDeck.logger.info(`Spindle ${__SPINDLE_VERSION__} starting`);

const dial = new SpindleDial();
streamDeck.actions.registerAction(dial);

let settle: ReturnType<typeof setTimeout> | undefined;
streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
	clearTimeout(settle);
	const settings = ev.settings;
	settle = setTimeout(() => dial.setGlobalSettings(settings), GLOBAL_SETTINGS_SETTLE_MS);
});

streamDeck
	.connect()
	.then(() => streamDeck.settings.getGlobalSettings<GlobalSettings>())
	.then((settings) => {
		// A PI change that arrived meanwhile is newer: let it win.
		if (settle === undefined) dial.setGlobalSettings(settings);
	})
	.catch((err: unknown) => streamDeck.logger.error(`Could not read global settings: ${err instanceof Error ? err.message : String(err)}`));
