// plugin.ts wires the SDK at import time: mock the SDK and the action, then import it fresh per test.
const TOKEN = "tok" + "-plugin-789";

const sd = vi.hoisted(() => {
	const scope = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
	const state = {
		onGlobal: undefined as undefined | ((ev: { settings: Record<string, unknown> }) => void),
		setGlobalSettings: vi.fn(),
		streamDeck: {
			logger: { ...scope(), createScope: vi.fn(scope) },
			actions: { registerAction: vi.fn() },
			settings: {
				onDidReceiveGlobalSettings: vi.fn((cb: (ev: { settings: Record<string, unknown> }) => void) => {
					state.onGlobal = cb;
				}),
				getGlobalSettings: vi.fn<() => Promise<Record<string, unknown>>>()
			},
			connect: vi.fn(() => Promise.resolve())
		}
	};
	return state;
});

const trust = vi.hoisted(() => vi.fn(() => "trusted"));

vi.mock("@elgato/streamdeck", () => ({ default: sd.streamDeck }));
vi.mock("../src/tlsTrust", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/tlsTrust")>()), trustSystemCertificates: trust }));
vi.mock("../src/actions/spindle-dial", () => ({
	SpindleDial: class {
		setGlobalSettings = sd.setGlobalSettings;
	}
}));

const flush = () => new Promise<void>((r) => setImmediate(r));
const logged = () => sd.streamDeck.logger.error.mock.calls.map(([m]) => String(m));

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	sd.onGlobal = undefined;
});

afterEach(() => {
	vi.useRealTimers();
});

test("a throw from the debounced global-settings apply is caught and logged redacted", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	sd.streamDeck.settings.getGlobalSettings.mockReturnValue(new Promise(() => {}));
	sd.setGlobalSettings.mockImplementation(() => {
		throw new Error(`apply failed for ${TOKEN}`);
	});
	await import("../src/plugin");
	sd.onGlobal!({ settings: { haUrl: "http://homeassistant.local:8123", token: ` ${TOKEN} ` } });
	expect(() => vi.advanceTimersByTime(800)).not.toThrow();
	expect(sd.setGlobalSettings).toHaveBeenCalledTimes(1);
	expect(logged()).toHaveLength(1);
	expect(logged()[0]).toContain("‹redacted›");
	expect(logged()[0]).not.toContain(TOKEN);
});

test("the startup error log is redacted", async () => {
	sd.streamDeck.settings.getGlobalSettings.mockResolvedValue({ haUrl: "http://homeassistant.local:8123", token: TOKEN });
	sd.setGlobalSettings.mockImplementation(() => {
		throw new Error(`apply failed for ${TOKEN}`);
	});
	await import("../src/plugin");
	await flush();
	expect(logged()).toHaveLength(1);
	expect(logged()[0]).toContain("‹redacted›");
	expect(logged()[0]).not.toContain(TOKEN);
});

test("trusts the OS certificate store before any action or connection exists", async () => {
	sd.streamDeck.settings.getGlobalSettings.mockReturnValue(new Promise(() => {}));
	await import("../src/plugin");
	expect(trust).toHaveBeenCalledTimes(1);
	const trustedAt = trust.mock.invocationCallOrder[0];
	expect(trustedAt).toBeLessThan(sd.streamDeck.actions.registerAction.mock.invocationCallOrder[0]);
	expect(trustedAt).toBeLessThan(sd.streamDeck.connect.mock.invocationCallOrder[0]);
});
