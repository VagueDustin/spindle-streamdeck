// Cover loader: fetch the player's picture from HA (or an external host), decode
// it, cover-fit it to the 240x240 master and pick its accent. The HA token is
// only ever sent to HA's own origin, and never appears in an error or a log.
import { pickAccent, type Rgb } from "./accent";
import { coverFit, decodeImage, type Rgba } from "./image";

export type CoverResult = { key: string; image: Rgba; accent: Rgb };

const MASTER_SIZE = 240;
const CACHE_SIZE = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 5_000_000;

/**
 * Relative "/api/..." paths join to `httpBase` and carry the token. An absolute
 * http(s) URL carries it only when it is on `httpBase`'s own origin. Anything
 * else (protocol-relative, other schemes, garbage) throws.
 */
export function resolvePictureUrl(httpBase: string, pictureUrl: string): { url: string; sendAuth: boolean } {
	const baseOrigin = new URL(httpBase).origin;
	if (pictureUrl.startsWith("/") && !pictureUrl.startsWith("//")) {
		const url = httpBase.replace(/\/+$/, "") + pictureUrl;
		// A path such as "/\evil" must still resolve onto the HA origin.
		if (new URL(url).origin !== baseOrigin) throw new Error("cover URL leaves the HA origin");
		return { url, sendAuth: true };
	}
	let parsed: URL;
	try {
		parsed = new URL(pictureUrl);
	} catch {
		throw new Error("invalid cover URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported cover URL scheme");
	return { url: pictureUrl, sendAuth: parsed.origin === baseOrigin };
}

type LoaderOptions = {
	httpBase: string;
	token: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	maxBytes?: number;
};

export class CoverLoader {
	private readonly httpBase: string;
	private readonly token: string;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly maxBytes: number;
	// Map iteration order is insertion order, so the first key is the least recently used.
	private readonly cache = new Map<string, CoverResult>();
	private readonly inFlight = new Map<string, Promise<CoverResult>>();

	constructor(opts: LoaderOptions) {
		this.httpBase = opts.httpBase;
		this.token = opts.token;
		this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	}

	/** Resolves with a decoded cover. Only successes are cached; a failure is retried by the next call. */
	load(pictureUrl: string): Promise<CoverResult> {
		const hit = this.cache.get(pictureUrl);
		if (hit) {
			this.cache.delete(pictureUrl);
			this.cache.set(pictureUrl, hit);
			return Promise.resolve(hit);
		}
		const pending = this.inFlight.get(pictureUrl);
		if (pending) return pending;

		const p = this.fetchCover(pictureUrl).then(
			(result) => {
				this.inFlight.delete(pictureUrl);
				this.cache.set(pictureUrl, result);
				while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string);
				return result;
			},
			(err: unknown) => {
				this.inFlight.delete(pictureUrl);
				throw err;
			}
		);
		this.inFlight.set(pictureUrl, p);
		return p;
	}

	private async fetchCover(pictureUrl: string): Promise<CoverResult> {
		const { url, sendAuth } = resolvePictureUrl(this.httpBase, pictureUrl);
		const bytes = await this.download(url, sendAuth);
		const image = coverFit(decodeImage(bytes), MASTER_SIZE, MASTER_SIZE);
		return { key: pictureUrl, image, accent: pickAccent(image) };
	}

	/** One request, with the timeout and the size cap both covering the body read. */
	private async download(url: string, sendAuth: boolean): Promise<Uint8Array> {
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const controller = new AbortController();
		const signal = AbortSignal.any([timeout, controller.signal]);
		let tooLarge = false;
		const abortTooLarge = () => {
			tooLarge = true;
			controller.abort();
		};
		const dropBody = (res: Response) => void res.body?.cancel().catch(() => undefined);

		try {
			const headers: Record<string, string> = {};
			if (sendAuth) headers.Authorization = `Bearer ${this.token}`;
			const res = await this.fetchImpl(url, { headers, signal });
			if (!res.ok) {
				dropBody(res);
				throw tag(new Error(`HTTP ${res.status}`));
			}
			const declared = Number(res.headers.get("content-length"));
			if (res.headers.has("content-length") && declared > this.maxBytes) {
				abortTooLarge();
				dropBody(res);
				throw tag(new Error("cover too large"));
			}
			if (!res.body) {
				const all = new Uint8Array(await res.arrayBuffer());
				if (all.length > this.maxBytes) throw tag(new Error("cover too large"));
				return all;
			}

			const reader = res.body.getReader();
			const chunks: Uint8Array[] = [];
			let total = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.length;
				if (total > this.maxBytes) {
					abortTooLarge();
					reader.cancel().catch(() => undefined);
					throw tag(new Error("cover too large"));
				}
				chunks.push(value);
			}
			const out = new Uint8Array(total);
			let offset = 0;
			for (const c of chunks) {
				out.set(c, offset);
				offset += c.length;
			}
			return out;
		} catch (e) {
			if (e instanceof Error && ours.has(e)) throw e;
			if (timeout.aborted) throw new Error("timeout");
			if (tooLarge) throw new Error("cover too large");
			// Network errors can carry request detail; keep the message generic.
			throw new Error("cover fetch failed");
		}
	}
}

// Errors this module raised itself, as opposed to ones fetch or the stream threw.
const ours = new WeakSet<Error>();
const tag = (e: Error): Error => {
	ours.add(e);
	return e;
};
