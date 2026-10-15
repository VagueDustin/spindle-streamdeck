import https from "node:https";
import type { AddressInfo } from "node:net";
import tls from "node:tls";
import { WebSocketServer } from "ws";
import { certErrorCode, mergeCaLists, trustSystemCertificates, type CaStore } from "../src/tlsTrust";
import { makeTestPki } from "./helpers/testCa";

const A = "pem-a";
const B = "pem-b";
const C = "pem-c";

/** An in-memory CA store with the Node ≥ 24.5 API. */
function fakeStore(defaults: string[], system: string[]) {
	const state = { defaults: [...defaults], sets: [] as string[][] };
	const store: CaStore = {
		getCACertificates: vi.fn((type: "default" | "system") => (type === "system" ? [...system] : [...state.defaults])),
		setDefaultCACertificates: vi.fn((certs: string[]) => {
			state.sets.push([...certs]);
			state.defaults = [...certs];
		})
	};
	return { store, state };
}

describe("mergeCaLists", () => {
	it("keeps the defaults first, appends system certificates and drops duplicates", () => {
		expect(mergeCaLists([A, B], [B, C, C])).toEqual([A, B, C]);
	});
});

describe("trustSystemCertificates", () => {
	it("sets the default CA list to default plus system", () => {
		const { store, state } = fakeStore([A, B], [B, C]);
		expect(trustSystemCertificates(store)).toBe("trusted");
		expect(state.sets).toEqual([[A, B, C]]);
	});

	it("is idempotent: a second call changes nothing", () => {
		const { store, state } = fakeStore([A], [C]);
		trustSystemCertificates(store);
		expect(trustSystemCertificates(store)).toBe("already");
		expect(state.sets).toEqual([[A, C]]);
	});

	it("leaves the store alone when the system certificates are already trusted (NODE_USE_SYSTEM_CA)", () => {
		const { store, state } = fakeStore([A, C], [C]);
		expect(trustSystemCertificates(store)).toBe("already");
		expect(state.sets).toEqual([]);
	});

	it("does nothing on a Node without the APIs", () => {
		const warn = vi.fn();
		expect(trustSystemCertificates({}, warn)).toBe("unsupported");
		expect(trustSystemCertificates({ getCACertificates: () => [A] }, warn)).toBe("unsupported");
		expect(warn).not.toHaveBeenCalled();
	});

	it("never throws: a failing store logs one warning", () => {
		const warn = vi.fn();
		const store: CaStore = {
			getCACertificates: () => {
				throw new Error("store unavailable");
			},
			setDefaultCACertificates: vi.fn()
		};
		expect(trustSystemCertificates(store, warn)).toBe("failed");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain("store unavailable");
		expect(store.setDefaultCACertificates).not.toHaveBeenCalled();
	});

	it("never throws when setting the list fails", () => {
		const warn = vi.fn();
		const { store } = fakeStore([A], [C]);
		store.setDefaultCACertificates = () => {
			throw new Error("bad certificate");
		};
		expect(trustSystemCertificates(store, warn)).toBe("failed");
		expect(warn).toHaveBeenCalledTimes(1);
	});
});

describe("certErrorCode", () => {
	const fetchFailed = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code }) });

	it.each([
		"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
		"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
		"CERT_HAS_EXPIRED",
		"DEPTH_ZERO_SELF_SIGNED_CERT",
		"SELF_SIGNED_CERT_IN_CHAIN",
		"ERR_TLS_CERT_ALTNAME_INVALID"
	])("finds %s in fetch's cause", (code) => {
		expect(certErrorCode(fetchFailed(code))).toBe(code);
	});

	it("ignores network errors that are not about the certificate", () => {
		expect(certErrorCode(fetchFailed("ECONNREFUSED"))).toBeUndefined();
		expect(certErrorCode(fetchFailed("ENOTFOUND"))).toBeUndefined();
		expect(certErrorCode(new Error("timeout"))).toBeUndefined();
		expect(certErrorCode("nope")).toBeUndefined();
		expect(certErrorCode(undefined)).toBeUndefined();
	});

	it("survives a cause cycle", () => {
		const a: Error & { cause?: unknown } = new Error("a");
		a.cause = a;
		expect(certErrorCode(a)).toBeUndefined();
	});
});

// The real runtime: undici's fetch and the global WebSocket must honour tls.setDefaultCACertificates.
describe("Node's fetch and WebSocket with tls.setDefaultCACertificates", () => {
	const api = tls as unknown as Required<CaStore>;
	let original: string[];
	let server: https.Server;
	let wss: WebSocketServer;
	let port: number;
	let ca: string;

	beforeAll(async () => {
		const pki = makeTestPki();
		ca = pki.ca;
		original = api.getCACertificates("default");
		server = https.createServer({ cert: pki.cert, key: pki.key }, (_req, res) => {
			res.writeHead(401);
			res.end();
		});
		wss = new WebSocketServer({ server });
		wss.on("connection", (socket) => socket.send("auth_required"));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		port = (server.address() as AddressInfo).port;
	});

	afterAll(async () => {
		api.setDefaultCACertificates(original);
		wss.close();
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	});

	const head = () => fetch(`https://127.0.0.1:${port}/api/`, { method: "HEAD" });
	const firstMessage = () =>
		new Promise<string>((resolve) => {
			const ws = new WebSocket(`wss://127.0.0.1:${port}/api/websocket`);
			ws.addEventListener("message", (ev) => {
				resolve(String(ev.data));
				ws.close();
			});
			ws.addEventListener("error", () => resolve("error"));
		});

	it("fails before the test CA is trusted, and works after", async () => {
		expect(typeof api.setDefaultCACertificates).toBe("function");

		const err = await head().then(
			() => undefined,
			(e: unknown) => e
		);
		expect(certErrorCode(err)).toBe("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
		expect(await firstMessage()).toBe("error");

		api.setDefaultCACertificates(mergeCaLists(api.getCACertificates("default"), [ca]));

		expect((await head()).status).toBe(401);
		expect(await firstMessage()).toBe("auth_required");
	});
});
