/** Bits of HA's MediaPlayerEntityFeature that Spindle cares about. */
export const Feature = {
	PAUSE: 1,
	VOLUME_SET: 4,
	VOLUME_MUTE: 8,
	PREVIOUS_TRACK: 16,
	NEXT_TRACK: 32,
	VOLUME_STEP: 1024,
	SELECT_SOURCE: 2048,
	PLAY: 16384
} as const;

export type RawEntity = { state: string; attributes: Record<string, unknown> };

export type PlayerState = {
	entityId: string;
	status: string;
	friendlyName: string;
	title?: string;
	artist?: string;
	album?: string;
	source?: string;
	appName?: string;
	/** 0–100 integer from `volume_level`; undefined when absent. */
	volume?: number;
	muted: boolean;
	features: number;
	/** `entity_picture_local`, else `entity_picture` (the first non-empty string). */
	pictureUrl?: string;
};

/** Raw HA text is capped (in code points) before it reaches the renderer: the marquee emits it twice per frame. */
export const MAX_TEXT_CODE_POINTS = 300;

function text(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	// Cheap bound first: a string of at most 300 UTF-16 units has at most 300 code points.
	if (value.length <= MAX_TEXT_CODE_POINTS) return value;
	let out = "";
	let n = 0;
	for (const cp of value) {
		if (n++ === MAX_TEXT_CODE_POINTS) break;
		out += cp;
	}
	return out;
}

/** A non-empty string, else undefined. */
function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function volumePercent(level: unknown): number | undefined {
	if (typeof level !== "number" || !Number.isFinite(level)) {
		return undefined;
	}
	return Math.min(100, Math.max(0, Math.round(level * 100)));
}

/** Normalises a raw HA entity into the fields the dial needs. Never throws. */
export function toPlayerState(entityId: string, raw: RawEntity): PlayerState {
	const a = raw.attributes;
	const friendlyName = text(a.friendly_name);
	const features = a.supported_features;
	return {
		entityId,
		status: raw.state,
		friendlyName: friendlyName ? friendlyName : entityId,
		title: text(a.media_title),
		artist: text(a.media_artist),
		album: text(a.media_album_name),
		source: text(a.source),
		appName: text(a.app_name),
		volume: volumePercent(a.volume_level),
		muted: a.is_volume_muted === true,
		features: typeof features === "number" && Number.isFinite(features) ? features : 0,
		pictureUrl: nonEmpty(a.entity_picture_local) ?? nonEmpty(a.entity_picture)
	};
}

/** True when every bit of `f` is set in the player's feature mask. */
export function has(p: PlayerState, f: number): boolean {
	return (p.features & f) === f;
}
