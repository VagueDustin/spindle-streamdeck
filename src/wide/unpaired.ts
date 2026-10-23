// A Wide dial with no Wide neighbour: after a short grace period (its partner's willAppear may still be
// on the way) it shows one static message, then sends nothing more. It is also a hub client with no
// entity, so the connection stays open for its settings, which is why it takes (and ignores) binding updates.
import { FALLBACK_ACCENT } from "../art/accent";
import { svgUri, type Priority } from "../dial/controller";
import { buildBackdrop } from "../render/backdrop";
import { renderForeground, type DialUi } from "../render/foreground";

/** How long a lone Wide dial waits for a partner before asking for one. */
export const UNPAIRED_GRACE_MS = 300;
export const UNPAIRED_MESSAGE = "Add a Wide dial next to this one";

const UI: DialUi = {
	mode: "volume",
	volume: 0,
	muted: false,
	volumeDisplay: "hidden",
	takeoverAlpha: 0,
	flashDir: 0,
	offset: 0,
	message: { headline: UNPAIRED_MESSAGE },
	dimmed: false,
	buffering: false
};

export class UnpairedWide {
	private sent = false;

	constructor(private readonly showAt: number) {}

	// Binding updates: the message does not depend on the connection or a player.
	setConnStatus(): void {}
	setPlayer(): void {}
	setCover(): void {}
	readonly coverKey = null;

	tick(): void {}

	urgent(): boolean {
		return false;
	}

	priority(t: number): Priority {
		return !this.sent && t >= this.showAt ? "full" : "none";
	}

	frame(t: number): Record<string, string> | null {
		if (this.priority(t) === "none") return null;
		this.sent = true;
		return { bg: buildBackdrop(null, FALLBACK_ACCENT), fg: svgUri(renderForeground(null, UI, FALLBACK_ACCENT, t).svg) };
	}
}
