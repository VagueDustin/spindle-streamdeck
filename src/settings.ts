export type GlobalSettings = { haUrl?: string; token?: string };
export type DialSettings = { entityId?: string; volumeStep?: number; sourceLabels?: string; tracksMode?: boolean; tapToSkip?: boolean };
/** The Wide pair's settings live on its left dial; `tracksMode` does not apply. */
export type WideSettings = Omit<DialSettings, "tracksMode">;
export type ResolvedDialSettings = {
	entityId: string | null;
	volumeStep: number;
	labels: Map<string, string>;
	tracksMode: boolean;
	/** Tapping the strip's left or right third skips back or forward; the middle still plays or pauses. */
	tapToSkip: boolean;
};

const DEFAULT_VOLUME_STEP = 2;
const MIN_VOLUME_STEP = 1;
const MAX_VOLUME_STEP = 10;
const HAS_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;

/**
 * Turns whatever the user pasted into an HA base URL and its WebSocket endpoint.
 * Accepts a missing scheme, whitespace, a trailing slash, frontend paths and query strings.
 * Never throws: anything unusable gives null.
 */
export function normalizeHaUrl(input: string | undefined): { httpBase: string; wsUrl: string } | null {
	if (typeof input !== "string") {
		return null;
	}
	const trimmed = input.trim();
	if (!trimmed) {
		return null;
	}
	try {
		const url = new URL(HAS_SCHEME.test(trimmed) ? trimmed : `http://${trimmed}`);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return null;
		}
		const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
		return {
			httpBase: `${url.protocol}//${url.host}`,
			wsUrl: `${wsProtocol}//${url.host}/api/websocket`
		};
	} catch {
		return null;
	}
}

const resolveEntity = (v: unknown): string | null => (typeof v === "string" && /^media_player\..+/.test(v) ? v : null);
const resolveVolumeStep = (v: unknown): number =>
	typeof v === "number" && !Number.isNaN(v) ? Math.min(MAX_VOLUME_STEP, Math.max(MIN_VOLUME_STEP, Math.round(v))) : DEFAULT_VOLUME_STEP;

export function resolveDialSettings(s: DialSettings): ResolvedDialSettings {
	return {
		entityId: resolveEntity(s.entityId),
		volumeStep: resolveVolumeStep(s.volumeStep),
		labels: parseSourceLabels(s.sourceLabels),
		tracksMode: s.tracksMode !== false,
		// Off by default on the dial, so existing setups keep "tap anywhere to play or pause".
		tapToSkip: s.tapToSkip === true
	};
}

/** The Wide pair is new, so its tap zones are on unless turned off. */
export function resolveWideSettings(s: WideSettings): ResolvedDialSettings {
	return { ...resolveDialSettings(s), tapToSkip: s.tapToSkip !== false };
}

export const COVER_DISPLAYS = ["art", "art-plain", "art-title", "text"] as const;
export type CoverDisplay = (typeof COVER_DISPLAYS)[number];
export type CoverKeySettings = { entityId?: string; display?: string };
export type ResolvedCoverKeySettings = { entityId: string | null; volumeStep: number; labels: Map<string, string>; display: CoverDisplay };

export function resolveCoverKeySettings(s: CoverKeySettings): ResolvedCoverKeySettings {
	const display = COVER_DISPLAYS.find((d) => d === s.display) ?? "art";
	return { entityId: resolveEntity(s.entityId), volumeStep: DEFAULT_VOLUME_STEP, labels: new Map(), display };
}

export const TRANSPORT_FUNCTIONS = ["playpause", "next", "previous", "mute", "volume_up", "volume_down"] as const;
export type TransportFunction = (typeof TRANSPORT_FUNCTIONS)[number];
export type TransportKeySettings = { entityId?: string; function?: string; volumeStep?: number };
export type ResolvedTransportKeySettings = { entityId: string | null; volumeStep: number; labels: Map<string, string>; fn: TransportFunction };

export function resolveTransportKeySettings(s: TransportKeySettings): ResolvedTransportKeySettings {
	const fn = TRANSPORT_FUNCTIONS.find((f) => f === s.function) ?? "playpause";
	return { entityId: resolveEntity(s.entityId), volumeStep: resolveVolumeStep(s.volumeStep), labels: new Map(), fn };
}

/**
 * Parses `Original = Label` lines. Keys are lower-cased and trimmed; malformed or empty lines are skipped.
 * Anything but a string (per-dial settings travel inside shared profiles) gives an empty map.
 */
export function parseSourceLabels(text: string | undefined): Map<string, string> {
	const labels = new Map<string, string>();
	if (typeof text !== "string") {
		return labels;
	}
	for (const line of text.split(/\r?\n/)) {
		const eq = line.indexOf("=");
		if (eq < 0) {
			continue;
		}
		const key = line.slice(0, eq).trim().toLowerCase();
		const value = line.slice(eq + 1).trim();
		if (key && value) {
			labels.set(key, value);
		}
	}
	return labels;
}

/** Maps the player's source, then its app name, through the labels; falls back to the raw source, then raw app name. */
export function mapSource(labels: Map<string, string>, source?: string, appName?: string): string | undefined {
	for (const candidate of [source, appName]) {
		const mapped = candidate ? labels.get(candidate.trim().toLowerCase()) : undefined;
		if (mapped) {
			return mapped;
		}
	}
	return source || appName || undefined;
}
