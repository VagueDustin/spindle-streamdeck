import { mapSource, normalizeHaUrl, parseSourceLabels, resolveDialSettings, resolveWideSettings } from "../src/settings";

test.each([
	["http://homeassistant.local:8123", "http://homeassistant.local:8123", "ws://homeassistant.local:8123/api/websocket"],
	["  https://ha.example.com/  ", "https://ha.example.com", "wss://ha.example.com/api/websocket"],
	["HTTPS://HA.Example.com:8443/lovelace/0?edit=1", "https://ha.example.com:8443", "wss://ha.example.com:8443/api/websocket"],
	["192.168.1.10:8123", "http://192.168.1.10:8123", "ws://192.168.1.10:8123/api/websocket"],
	["ha.example.com", "http://ha.example.com", "ws://ha.example.com/api/websocket"],
	["https://ha.example.com:443/#frag", "https://ha.example.com", "wss://ha.example.com/api/websocket"],
	["\thttp://homeassistant.local:8123/lovelace/0\n", "http://homeassistant.local:8123", "ws://homeassistant.local:8123/api/websocket"],
])("normalizeHaUrl(%s)", (input, http, ws) => {
	expect(normalizeHaUrl(input)).toEqual({ httpBase: http, wsUrl: ws });
});

test.each([
	"", "   ", "not a url", "ftp://x", undefined,
	"http://", "://", "http://exa mple.com", "http://[bad", "javascript:alert(1)", "\u0000", "http://a b:8123/x",
])("normalizeHaUrl rejects %s", (bad) => {
	expect(normalizeHaUrl(bad as string)).toBeNull();
});

test("normalizeHaUrl never throws on non-string input", () => {
	expect(normalizeHaUrl(null as unknown as string)).toBeNull();
	expect(normalizeHaUrl(42 as unknown as string)).toBeNull();
	expect(normalizeHaUrl({} as unknown as string)).toBeNull();
});

test("resolveDialSettings defaults and clamps", () => {
	expect(resolveDialSettings({})).toMatchObject({ entityId: null, volumeStep: 2, tracksMode: true });
	expect(resolveDialSettings({ volumeStep: 0 }).volumeStep).toBe(1);
	expect(resolveDialSettings({ volumeStep: 99 }).volumeStep).toBe(10);
	expect(resolveDialSettings({ entityId: "light.x" }).entityId).toBeNull(); // only media_player.*
});

test("resolveDialSettings entity, step and tracks handling", () => {
	expect(resolveDialSettings({ entityId: "media_player.living_room" }).entityId).toBe("media_player.living_room");
	expect(resolveDialSettings({ entityId: "media_player." }).entityId).toBeNull();
	expect(resolveDialSettings({ entityId: "" }).entityId).toBeNull();
	expect(resolveDialSettings({ volumeStep: Number.NaN }).volumeStep).toBe(2);
	expect(resolveDialSettings({ volumeStep: "5" as unknown as number }).volumeStep).toBe(2);
	expect(resolveDialSettings({ volumeStep: 3.6 }).volumeStep).toBe(4);
	expect(resolveDialSettings({ volumeStep: -4 }).volumeStep).toBe(1);
	expect(resolveDialSettings({ tracksMode: false }).tracksMode).toBe(false);
	expect(resolveDialSettings({ tracksMode: true }).tracksMode).toBe(true);
});

test("resolveDialSettings parses source labels", () => {
	expect(resolveDialSettings({ sourceLabels: "HDMI = TV" }).labels.get("hdmi")).toBe("TV");
	expect(resolveDialSettings({}).labels.size).toBe(0);
});

test("source labels: case-insensitive, source then app_name", () => {
	const m = parseSourceLabels("Line In = Turntable\n spotify=Spotify Connect \n\nbad line\n = x");
	expect(mapSource(m, "line in", "AirPlay")).toBe("Turntable");
	expect(mapSource(m, "HDMI", "Spotify")).toBe("Spotify Connect");
	expect(mapSource(m, "HDMI", undefined)).toBe("HDMI");
	expect(mapSource(m, undefined, "AirPlay")).toBe("AirPlay");
	expect(mapSource(new Map(), undefined, undefined)).toBeUndefined();
});

test("parseSourceLabels edge cases", () => {
	const m = parseSourceLabels("a=b=c\r\nempty=\n  Mixed Case  =  Value  \nno-equals");
	expect([...m.entries()]).toEqual([["a", "b=c"], ["mixed case", "Value"]]);
	expect(parseSourceLabels(undefined).size).toBe(0);
	expect(parseSourceLabels("").size).toBe(0);
});

test("parseSourceLabels returns an empty map for any non-string (a crafted shared profile)", () => {
	for (const bad of [42, true, null, {}, ["a=b"], { split: () => ["a=b"] }]) {
		expect(parseSourceLabels(bad as never).size).toBe(0);
	}
	expect(resolveDialSettings({ sourceLabels: 7 as never }).labels.size).toBe(0);
});

test("mapSource trims the source before lookup", () => {
	const m = parseSourceLabels("line in=Turntable");
	expect(mapSource(m, "  Line In ", undefined)).toBe("Turntable");
});

test("tap zones: off by default on the dial, on by default on the Wide pair", () => {
	expect(resolveDialSettings({}).tapToSkip).toBe(false);
	expect(resolveDialSettings({ tapToSkip: true }).tapToSkip).toBe(true);
	expect(resolveWideSettings({}).tapToSkip).toBe(true);
	expect(resolveWideSettings({ tapToSkip: false }).tapToSkip).toBe(false);
});
