import { Feature, has, toPlayerState } from "../../src/ha/playerState";

const ID = "media_player.living_room";

test("maps attributes to a PlayerState", () => {
	const p = toPlayerState(ID, {
		state: "playing",
		attributes: {
			friendly_name: "Living Room",
			media_title: "Blue in Green",
			media_artist: "Example Quartet",
			media_album_name: "Kind of Fictional",
			source: "Optical",
			app_name: "Example Player",
			volume_level: 0.42,
			is_volume_muted: true,
			supported_features: 152463,
			entity_picture: "/api/media_player_proxy/media_player.living_room?token=abc"
		}
	});
	expect(p).toEqual({
		entityId: ID,
		status: "playing",
		friendlyName: "Living Room",
		title: "Blue in Green",
		artist: "Example Quartet",
		album: "Kind of Fictional",
		source: "Optical",
		appName: "Example Player",
		volume: 42,
		muted: true,
		features: 152463,
		pictureUrl: "/api/media_player_proxy/media_player.living_room?token=abc"
	});
});

test("an empty entity gets safe defaults", () => {
	const p = toPlayerState(ID, { state: "off", attributes: {} });
	expect(p).toMatchObject({ entityId: ID, status: "off", friendlyName: ID, muted: false, features: 0 });
	expect(p.title).toBeUndefined();
	expect(p.artist).toBeUndefined();
	expect(p.album).toBeUndefined();
	expect(p.source).toBeUndefined();
	expect(p.appName).toBeUndefined();
	expect(p.volume).toBeUndefined();
	expect(p.pictureUrl).toBeUndefined();
});

test("friendlyName falls back to the entity id when missing, empty or not a string", () => {
	expect(toPlayerState(ID, { state: "idle", attributes: {} }).friendlyName).toBe(ID);
	expect(toPlayerState(ID, { state: "idle", attributes: { friendly_name: "" } }).friendlyName).toBe(ID);
	expect(toPlayerState(ID, { state: "idle", attributes: { friendly_name: 7 } }).friendlyName).toBe(ID);
});

test.each([
	[0.335, 34],
	[0.42, 42],
	[0, 0],
	[1, 100],
	[1.5, 100],
	[-0.2, 0],
	[250, 100]
])("volume %s rounds and clamps to %s", (level, expected) => {
	expect(toPlayerState(ID, { state: "on", attributes: { volume_level: level } }).volume).toBe(expected);
});

test.each([["0.4"], [null], [undefined], [Number.NaN], [Infinity], [{}]])("non-number volume %s gives undefined", (level) => {
	expect(toPlayerState(ID, { state: "on", attributes: { volume_level: level } }).volume).toBeUndefined();
});

test("entity_picture_local beats entity_picture", () => {
	const p = toPlayerState(ID, {
		state: "playing",
		attributes: { entity_picture: "/api/media_player_proxy/x", entity_picture_local: "/local/cover.jpg" }
	});
	expect(p.pictureUrl).toBe("/local/cover.jpg");
});

test("entity_picture is used when entity_picture_local is absent or not a string", () => {
	expect(toPlayerState(ID, { state: "playing", attributes: { entity_picture: "/a" } }).pictureUrl).toBe("/a");
	expect(toPlayerState(ID, { state: "playing", attributes: { entity_picture: "/a", entity_picture_local: 5 } }).pictureUrl).toBe("/a");
});

test("text fields accept only strings", () => {
	const p = toPlayerState(ID, {
		state: "playing",
		attributes: { media_title: 12, media_artist: ["a"], media_album_name: null, source: {}, app_name: false, entity_picture: 3 }
	});
	expect(p.title).toBeUndefined();
	expect(p.artist).toBeUndefined();
	expect(p.album).toBeUndefined();
	expect(p.source).toBeUndefined();
	expect(p.appName).toBeUndefined();
	expect(p.pictureUrl).toBeUndefined();
});

test("muted is true only for a literal true", () => {
	const muted = (v: unknown) => toPlayerState(ID, { state: "on", attributes: { is_volume_muted: v } }).muted;
	expect(muted(true)).toBe(true);
	expect(muted(false)).toBe(false);
	expect(muted("true")).toBe(false);
	expect(muted(1)).toBe(false);
	expect(muted(undefined)).toBe(false);
});

test("features: non-number becomes 0", () => {
	const features = (v: unknown) => toPlayerState(ID, { state: "on", attributes: { supported_features: v } }).features;
	expect(features(152463)).toBe(152463);
	expect(features("152463")).toBe(0);
	expect(features(null)).toBe(0);
	expect(features(Number.NaN)).toBe(0);
	expect(features(undefined)).toBe(0);
});

test("has() tests feature bits", () => {
	const p = toPlayerState(ID, { state: "on", attributes: { supported_features: Feature.PAUSE | Feature.VOLUME_SET | Feature.NEXT_TRACK } });
	expect(has(p, Feature.PAUSE)).toBe(true);
	expect(has(p, Feature.VOLUME_SET)).toBe(true);
	expect(has(p, Feature.NEXT_TRACK)).toBe(true);
	expect(has(p, Feature.PREVIOUS_TRACK)).toBe(false);
	expect(has(p, Feature.VOLUME_STEP)).toBe(false);
	expect(has(p, Feature.PAUSE | Feature.PREVIOUS_TRACK)).toBe(false);
});

test("Feature constants match HA MediaPlayerEntityFeature", () => {
	expect(Feature).toEqual({
		PAUSE: 1,
		VOLUME_SET: 4,
		VOLUME_MUTE: 8,
		PREVIOUS_TRACK: 16,
		NEXT_TRACK: 32,
		VOLUME_STEP: 1024,
		SELECT_SOURCE: 2048,
		PLAY: 16384
	});
});
