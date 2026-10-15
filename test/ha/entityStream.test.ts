import { readFileSync } from "node:fs";
import { applyCompressed, applyStateChanged } from "../../src/ha/entityStream";
import { toPlayerState, type RawEntity } from "../../src/ha/playerState";

const ID = "media_player.living_room";
const events = JSON.parse(readFileSync(new URL("../fixtures/subscribe_entities.json", import.meta.url), "utf8")) as unknown[];

function player(store: Map<string, RawEntity>) {
	const raw = store.get(ID);
	if (!raw) {
		throw new Error("entity missing from store");
	}
	return toPlayerState(ID, raw);
}

test("the fixture replays to the expected end state at every step", () => {
	const store = new Map<string, RawEntity>();

	expect(applyCompressed(store, events[0])).toEqual(new Set([ID]));
	let p = player(store);
	expect(p.status).toBe("playing");
	expect(p.volume).toBe(42);
	expect(p.pictureUrl?.startsWith("/api/media_player_proxy/")).toBe(true);
	expect(p.title).toBe("Blue in Green");
	expect(p.artist).toBe("Example Quartet");
	const firstPicture = p.pictureUrl;

	expect(applyCompressed(store, events[1])).toEqual(new Set([ID]));
	p = player(store);
	expect(p.status).toBe("paused");
	expect(p.title).toBe("Blue in Green");
	expect(p.volume).toBe(42);

	expect(applyCompressed(store, events[2])).toEqual(new Set([ID]));
	p = player(store);
	expect(p.status).toBe("playing");
	expect(p.title).toBe("So What");
	expect(p.album).toBe("Kind of Fictional (Deluxe)");
	expect(p.pictureUrl).not.toBe(firstPicture);
	expect(p.pictureUrl).toContain("cache=4d5e6f");
	expect(p.artist).toBe("Example Quartet");
	expect(p.friendlyName).toBe("Living Room");

	// The same diff also names an entity that was never subscribed: it must be ignored.
	expect(applyCompressed(store, events[3])).toEqual(new Set([ID]));
	expect(player(store).volume).toBe(55);
	expect(store.has("media_player.bedroom")).toBe(false);

	expect(applyCompressed(store, events[4])).toEqual(new Set([ID]));
	p = player(store);
	expect(p.artist).toBeUndefined();
	expect(p.title).toBe("So What");
	expect("media_artist" in (store.get(ID)?.attributes ?? {})).toBe(false);

	expect(applyCompressed(store, events[5])).toEqual(new Set([ID]));
	expect(store.has(ID)).toBe(false);
});

test("a replaces an entity entirely", () => {
	const store = new Map<string, RawEntity>([[ID, { state: "paused", attributes: { media_title: "Old", source: "HDMI" } }]]);
	applyCompressed(store, { a: { [ID]: { s: "playing", a: { media_title: "New" }, c: "x", lc: 1 } } });
	expect(store.get(ID)).toEqual({ state: "playing", attributes: { media_title: "New" } });
});

test("a tolerates a missing attribute bag and skips malformed entries", () => {
	const store = new Map<string, RawEntity>();
	const changed = applyCompressed(store, { a: { [ID]: { s: "idle" }, "media_player.bad": 5, "media_player.worse": null } });
	expect(changed).toEqual(new Set([ID]));
	expect(store.get(ID)).toEqual({ state: "idle", attributes: {} });
});

test("c merges attributes and ignores lc, lu and context keys", () => {
	const store = new Map<string, RawEntity>([[ID, { state: "playing", attributes: { media_title: "A", volume_level: 0.1 } }]]);
	const changed = applyCompressed(store, {
		c: { [ID]: { "+": { a: { volume_level: 0.2 }, lc: 5, lu: 6, c: "ctx" } } }
	});
	expect(changed).toEqual(new Set([ID]));
	expect(store.get(ID)).toEqual({ state: "playing", attributes: { media_title: "A", volume_level: 0.2 } });
});

test("c with only bookkeeping keys reports no change", () => {
	const store = new Map<string, RawEntity>([[ID, { state: "playing", attributes: { media_title: "A" } }]]);
	expect(applyCompressed(store, { c: { [ID]: { "+": { lu: 6, lc: 5, c: "ctx" } } } })).toEqual(new Set());
	expect(store.get(ID)).toEqual({ state: "playing", attributes: { media_title: "A" } });
});

test("c removing an attribute that is not present reports no change", () => {
	const store = new Map<string, RawEntity>([[ID, { state: "playing", attributes: { media_title: "A" } }]]);
	expect(applyCompressed(store, { c: { [ID]: { "-": { a: ["media_artist"] } } } })).toEqual(new Set());
});

test("c does not mutate the previous entity object", () => {
	const before: RawEntity = { state: "playing", attributes: { media_title: "A" } };
	const store = new Map<string, RawEntity>([[ID, before]]);
	applyCompressed(store, { c: { [ID]: { "+": { s: "paused", a: { media_title: "B" } } } } });
	expect(before).toEqual({ state: "playing", attributes: { media_title: "A" } });
});

test("a __proto__ key in a diff cannot pollute prototypes", () => {
	const store = new Map<string, RawEntity>([[ID, { state: "playing", attributes: {} }]]);
	const msg = JSON.parse('{"c":{"media_player.living_room":{"+":{"a":{"__proto__":{"polluted":true}}}}}}') as unknown;
	applyCompressed(store, msg);
	expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	expect((store.get(ID)?.attributes as Record<string, unknown>).polluted).toBeUndefined();
});

test("r deletes the entity and reports its id; unknown ids report nothing", () => {
	const store = new Map<string, RawEntity>([[ID, { state: "playing", attributes: {} }]]);
	expect(applyCompressed(store, { r: ["media_player.other", ID, 5] })).toEqual(new Set([ID]));
	expect(store.size).toBe(0);
});

test("a message can carry a, c and r together", () => {
	const store = new Map<string, RawEntity>([["media_player.old", { state: "on", attributes: {} }]]);
	const changed = applyCompressed(store, {
		a: { [ID]: { s: "playing", a: {} } },
		c: { [ID]: { "+": { s: "paused" } } },
		r: ["media_player.old"]
	});
	expect(changed).toEqual(new Set([ID, "media_player.old"]));
	expect(store.get(ID)?.state).toBe("paused");
	expect(store.has("media_player.old")).toBe(false);
});

test.each([
	["null", null],
	["undefined", undefined],
	["a number", 5],
	["a string", "hello"],
	["an array", []],
	["c: 5", { c: 5 }],
	["c: null", { c: null }],
	["c: []", { c: [] }],
	["a: 5", { a: 5 }],
	["r: 5", { r: 5 }],
	["r: object", { r: {} }],
	["c entry null", { c: { [ID]: null } }],
	["c entry number", { c: { [ID]: 5 } }],
	["+ not an object", { c: { [ID]: { "+": 5 } } }],
	["+.a not an object", { c: { [ID]: { "+": { a: 5 } } } }],
	["- not an object", { c: { [ID]: { "-": 5 } } }],
	["-.a not an array", { c: { [ID]: { "-": { a: "media_title" } } } }],
	["unknown entity in c", { c: { "media_player.unknown": { "+": { s: "on" } } } }]
])("malformed message (%s) returns an empty set without throwing", (_name, msg) => {
	const store = new Map<string, RawEntity>([[ID, { state: "playing", attributes: { media_title: "A" } }]]);
	let changed = new Set<string>(["sentinel"]);
	expect(() => {
		changed = applyCompressed(store, msg);
	}).not.toThrow();
	expect(changed.size).toBe(0);
	expect(store.get(ID)).toEqual({ state: "playing", attributes: { media_title: "A" } });
});

test("c ignores non-string entries in -.a", () => {
	const store = new Map<string, RawEntity>([[ID, { state: "playing", attributes: { media_title: "A", media_artist: "B" } }]]);
	expect(applyCompressed(store, { c: { [ID]: { "-": { a: [5, null, "media_artist"] } } } })).toEqual(new Set([ID]));
	expect(store.get(ID)?.attributes).toEqual({ media_title: "A" });
});

describe("applyStateChanged", () => {
	test("sets the entity from new_state", () => {
		const store = new Map<string, RawEntity>();
		const changed = applyStateChanged(store, {
			entity_id: ID,
			new_state: { entity_id: ID, state: "playing", attributes: { media_title: "A" }, last_changed: "2026-01-01T00:00:00+00:00" },
			old_state: null
		});
		expect(changed).toEqual(new Set([ID]));
		expect(store.get(ID)).toEqual({ state: "playing", attributes: { media_title: "A" } });
	});

	test("new_state: null deletes the entry", () => {
		const store = new Map<string, RawEntity>([[ID, { state: "playing", attributes: {} }]]);
		expect(applyStateChanged(store, { entity_id: ID, new_state: null, old_state: { state: "playing" } })).toEqual(new Set([ID]));
		expect(store.has(ID)).toBe(false);
	});

	test("new_state: null for an unknown entity changes nothing", () => {
		const store = new Map<string, RawEntity>();
		expect(applyStateChanged(store, { entity_id: ID, new_state: null })).toEqual(new Set());
	});

	test("falls back to new_state.entity_id when the event has no entity_id", () => {
		const store = new Map<string, RawEntity>();
		expect(applyStateChanged(store, { new_state: { entity_id: ID, state: "idle", attributes: {} } })).toEqual(new Set([ID]));
		expect(store.get(ID)?.state).toBe("idle");
	});

	test("unwraps a full event object by reading .data", () => {
		const store = new Map<string, RawEntity>();
		const changed = applyStateChanged(store, {
			event_type: "state_changed",
			data: { entity_id: ID, new_state: { state: "paused", attributes: { media_title: "A" } } }
		});
		expect(changed).toEqual(new Set([ID]));
		expect(store.get(ID)).toEqual({ state: "paused", attributes: { media_title: "A" } });
	});

	test("a missing attribute bag becomes an empty one", () => {
		const store = new Map<string, RawEntity>();
		applyStateChanged(store, { entity_id: ID, new_state: { state: "off" } });
		expect(store.get(ID)).toEqual({ state: "off", attributes: {} });
	});

	test.each([
		["null", null],
		["undefined", undefined],
		["a number", 5],
		["an empty object", {}],
		["no id anywhere", { new_state: { state: "on", attributes: {} } }],
		["empty entity id", { entity_id: "", new_state: { state: "on" } }],
		["new_state not an object", { entity_id: ID, new_state: 5 }],
		["new_state without state", { entity_id: ID, new_state: { attributes: {} } }],
		["data not an object", { data: 5 }]
	])("malformed event (%s) returns an empty set without throwing", (_name, event) => {
		const store = new Map<string, RawEntity>([[ID, { state: "playing", attributes: {} }]]);
		let changed = new Set<string>(["sentinel"]);
		expect(() => {
			changed = applyStateChanged(store, event);
		}).not.toThrow();
		expect(changed.size).toBe(0);
		expect(store.get(ID)).toEqual({ state: "playing", attributes: {} });
	});
});
