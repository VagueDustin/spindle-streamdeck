import streamDeck from "@elgato/streamdeck";

import { SpindleDial } from "./actions/spindle-dial";

streamDeck.logger.info(`Spindle ${__SPINDLE_VERSION__} starting`);

streamDeck.actions.registerAction(new SpindleDial());

streamDeck.connect();
