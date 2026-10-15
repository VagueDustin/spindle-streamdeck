export type GlobalSettings = { haUrl?: string; token?: string };
export type DialSettings = { entityId?: string; volumeStep?: number; sourceLabels?: string; tracksMode?: boolean };
export type ResolvedDialSettings = {
	entityId: string | null;
	volumeStep: number;
	labels: Map<string, string>;
	tracksMode: boolean;
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

export function resolveDialSettings(s: DialSettings): ResolvedDialSettings {
	const entityId = typeof s.entityId === "string" && /^media_player\..+/.test(s.entityId) ? s.entityId : null;
	const step = typeof s.volumeStep === "number" && !Number.isNaN(s.volumeStep)
		? Math.min(MAX_VOLUME_STEP, Math.max(MIN_VOLUME_STEP, Math.round(s.volumeStep)))
		: DEFAULT_VOLUME_STEP;
	return {
		entityId,
		volumeStep: step,
		labels: parseSourceLabels(s.sourceLabels),
		tracksMode: s.tracksMode !== false
	};
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
