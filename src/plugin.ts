import streamDeck from "@elgato/streamdeck";

import { SpindleDial } from "./actions/spindle-dial";
import { setConnectionLogger } from "./ha/connection";
import { redact } from "./log";
import type { GlobalSettings } from "./settings";

/**
 * sdpi-components saves the URL and token fields on every keystroke. Waiting for typing to pause
 * keeps a half-typed URL or token from opening connections (a half-typed token would count toward
 * HA's IP ban as a failed login).
 */
const GLOBAL_SETTINGS_SETTLE_MS = 800;

// Before any connection exists: every HA connection logs through this (redacted) scope.
// Never raise the SDK's log level to trace: the SDK then logs every raw message it exchanges
// with Stream Deck, including didReceiveGlobalSettings, which carries the HA token.
setConnectionLogger(streamDeck.logger.createScope("ha"));
streamDeck.logger.info(`Spindle ${__SPINDLE_VERSION__} starting`);

const dial = new SpindleDial();
streamDeck.actions.registerAction(dial);

/** The newest token seen (as typed and trimmed), so these error logs can redact it. */
let secrets: string[] = [];
const remember = (s: GlobalSettings | undefined) => {
	if (typeof s?.token === "string") secrets = [s.token, s.token.trim()];
};
const logError = (what: string, err: unknown) =>
	streamDeck.logger.error(redact(`${what}: ${err instanceof Error ? err.message : String(err)}`, secrets));

let settle: ReturnType<typeof setTimeout> | undefined;
streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
	clearTimeout(settle);
	const settings = ev.settings;
	remember(settings);
	settle = setTimeout(() => {
		// A throw inside a timer callback would end the plugin process.
		try {
			dial.setGlobalSettings(settings);
		} catch (err) {
			logError("Could not apply global settings", err);
		}
	}, GLOBAL_SETTINGS_SETTLE_MS);
});

streamDeck
	.connect()
	.then(() => streamDeck.settings.getGlobalSettings<GlobalSettings>())
	.then((settings) => {
		// A PI change that arrived meanwhile is newer: let it win.
		if (settle === undefined) {
			remember(settings);
			dial.setGlobalSettings(settings);
		}
	})
	.catch((err: unknown) => logError("Could not load global settings", err));
