// Trust the certificates the operating system trusts, the way browsers and Home Assistant's own
// apps do. Stream Deck starts the plugin without NODE_USE_SYSTEM_CA, so Node otherwise trusts only
// its bundled Mozilla list, and an HA served with a certificate from a private CA (one the OS
// trusts) fails the wss:// handshake. No SDK import, so it is unit-testable.
import { isIP } from "node:net";
import tls from "node:tls";

/** The slice of `node:tls` this module uses. Both functions are optional: older Node lacks them. */
export type CaStore = {
	getCACertificates?: (type: "default" | "system") => string[];
	setDefaultCACertificates?: (certs: string[]) => void;
};

/**
 * "trusted": the OS certificates were added. "already": nothing to add (already done, or Node was
 * started with NODE_USE_SYSTEM_CA). "unsupported": this Node lacks the APIs. "failed": see the warning.
 */
export type TrustResult = "trusted" | "already" | "unsupported" | "failed";

/** `defaults` first, then each system certificate not already present; duplicates dropped. */
export function mergeCaLists(defaults: readonly string[], system: readonly string[]): string[] {
	return [...new Set([...defaults, ...system])];
}

const applied = new WeakSet<CaStore>();

/**
 * Makes the OS certificate store part of Node's default CA list, which `fetch` and the global
 * `WebSocket` (undici) use for every https/wss connection. Call it once at startup, before any
 * connection. Idempotent, and it never throws: a failure logs one warning and leaves Node's list as it was.
 *
 * Needs `tls.getCACertificates` (Node 22.15 / 23.10) and `tls.setDefaultCACertificates` (Node 24.5).
 * On an older Node it does nothing; users can then set the environment variable NODE_USE_SYSTEM_CA=1
 * for the Stream Deck app instead.
 */
export function trustSystemCertificates(store: CaStore = tls as CaStore, warn: (msg: string) => void = () => {}): TrustResult {
	const { getCACertificates, setDefaultCACertificates } = store;
	if (typeof getCACertificates !== "function" || typeof setDefaultCACertificates !== "function") {
		return "unsupported";
	}
	if (applied.has(store)) {
		return "already";
	}
	try {
		const defaults = getCACertificates.call(store, "default");
		const system = getCACertificates.call(store, "system");
		const known = new Set(defaults);
		if (!system.some((cert) => !known.has(cert))) {
			applied.add(store);
			return "already";
		}
		setDefaultCACertificates.call(store, mergeCaLists(defaults, system));
		applied.add(store);
		return "trusted";
	} catch (err) {
		warn(`Could not add the operating system's certificates: ${err instanceof Error ? err.message : String(err)}`);
		return "failed";
	}
}

const CERT_CODES = new Set(["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "ERR_TLS_CERT_ALTNAME_INVALID"]);

function isCertCode(code: string): boolean {
	return code.startsWith("UNABLE_TO_") || code.startsWith("CERT_") || CERT_CODES.has(code);
}

/**
 * The TLS certificate error code in `err` or its `cause` chain (fetch rejects with
 * TypeError("fetch failed") whose cause carries the code), or undefined when it is not a certificate error.
 */
export function certErrorCode(err: unknown): string | undefined {
	const seen = new Set<unknown>();
	for (let e = err; typeof e === "object" && e !== null && !seen.has(e); e = (e as { cause?: unknown }).cause) {
		seen.add(e);
		const code = (e as { code?: unknown }).code;
		if (typeof code === "string" && isCertCode(code)) {
			return code;
		}
	}
	return undefined;
}

/** The slice of a `tls.TLSSocket` the handshake probe uses. */
export type TlsSocketLike = {
	on(event: string, listener: (arg?: unknown) => void): unknown;
	setTimeout(ms: number, callback: () => void): unknown;
	end(): unknown;
	destroy(): unknown;
};

/** `tls.connect`, or a stand-in for tests. */
export type TlsConnect = (options: tls.ConnectionOptions) => TlsSocketLike;

/**
 * A TLS-only handshake with host:port, verified against Node's default CA list (the same one fetch
 * and WebSocket use). Resolves with the certificate error code, or undefined when the handshake
 * succeeds or fails for another reason (refused, timeout, ...). Sends no HTTP request: the socket is
 * closed as soon as the handshake completes. Never rejects.
 */
export function tlsHandshakeCertError(host: string, port: number, timeoutMs: number, connect: TlsConnect = tls.connect): Promise<string | undefined> {
	return new Promise((resolve) => {
		let socket: TlsSocketLike;
		try {
			// SNI takes a host name only: Node warns when servername is an IP address.
			socket = connect(isIP(host) ? { host, port } : { host, port, servername: host });
		} catch (err) {
			resolve(certErrorCode(err));
			return;
		}
		let settled = false;
		const finish = (code: string | undefined) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(code);
		};
		socket.on("secureConnect", () => {
			socket.end();
			finish(undefined);
		});
		// Stays attached, so a late error (a reset after end()) is never unhandled.
		socket.on("error", (err) => finish(certErrorCode(err)));
		socket.setTimeout(timeoutMs, () => finish(undefined));
	});
}
