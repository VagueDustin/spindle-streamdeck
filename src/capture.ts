// Dev-only frame capture: a build made with SPINDLE_CAPTURE=1 records every
// setFeedback payload it sends, so the README gallery can show real frames with real covers
// (`npm run gallery:captures`). Normal builds have __SPINDLE_CAPTURE__ false and drop this module.
//
// Each sent payload becomes `capture/<n>-<dial>.json`, holding `{ t, dial, fg?, bg? }` with only
// the keys that payload had. Nothing else is ever written: no settings, no token. Writes run on
// a promise chain, off the frame loop, and the folder keeps only the newest `keep` files.
import fs from "node:fs";
import path from "node:path";
import type { FeedbackSink } from "./loop";

/** How many capture files stay on disk; the oldest goes when a new one exceeds this. */
export const CAPTURE_KEEP = 600;
/** Write errors are reported at most once per this long. */
const ERROR_LOG_MS = 10_000;
/** Payloads queued behind a slow disk beyond this are dropped rather than held in memory. */
const MAX_PENDING = 100;

const NAME = /^(\d+)-(\d+)\.json$/;

/** `000123-2.json`: the zero-padded counter, then the dial index. */
export function captureName(n: number, dial: number): string {
	return `${String(n).padStart(6, "0")}-${dial}.json`;
}

export function parseCaptureName(name: string): { n: number; dial: number } | null {
	const m = NAME.exec(name);
	return m ? { n: Number(m[1]), dial: Number(m[2]) } : null;
}

/**
 * The repo's `capture/` folder: beside the plugin folder, after resolving the junction that
 * `streamdeck link` puts in the Stream Deck plugins folder (otherwise `..` would be that folder).
 * Null when the plugin is not running from a checkout (no package.json beside it), so a
 * capture build installed some other way writes nothing.
 *
 * Stream Deck starts the plugin with its working directory set to the .sdPlugin folder; the SDK
 * relies on that too (getPluginUUID reads process.cwd(), and the logs go to `<cwd>/logs`).
 */
export function captureDirFor(pluginDir: string, sys: { realpath(p: string): string; exists(p: string): boolean }): string | null {
	const repo = path.dirname(sys.realpath(pluginDir));
	return sys.exists(path.join(repo, "package.json")) ? path.join(repo, "capture") : null;
}

/**
 * The recorder for a capture build, writing to the repo's capture/ folder; null (with a warning)
 * when the plugin is not running from a checkout. `log` lines go through the dial's redacting logger.
 */
export function openCapture(log: { info(msg: string): void; warn(msg: string): void }): CaptureRecorder | null {
	let dir: string | null;
	try {
		dir = captureDirFor(process.cwd(), { realpath: (p) => fs.realpathSync(p), exists: (p) => fs.existsSync(p) });
	} catch (err) {
		log.warn(`Frame capture could not find its folder, so it is off: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
	if (!dir) {
		log.warn("Frame capture build, but the plugin is not running from a checkout: capture is off");
		return null;
	}
	log.info(`Frame capture on: writing sent frames to ${dir}`);
	return new CaptureRecorder({ dir, onError: (err) => log.warn(`Frame capture failed: ${err instanceof Error ? err.message : String(err)}`) });
}

/** The slice of node:fs/promises the recorder uses; tests pass an in-memory one. */
export type CaptureFs = {
	mkdir(dir: string, opts: { recursive: true }): Promise<unknown>;
	readdir(dir: string): Promise<string[]>;
	writeFile(file: string, data: string): Promise<void>;
	unlink(file: string): Promise<void>;
};

// fs.promises, read inside each call: a normal build then keeps nothing of this module, not even
// an import of node:fs/promises or a top-level property read.
const nodeFs: CaptureFs = {
	mkdir: (dir, opts) => fs.promises.mkdir(dir, opts),
	readdir: (dir) => fs.promises.readdir(dir),
	writeFile: (file, data) => fs.promises.writeFile(file, data),
	unlink: (file) => fs.promises.unlink(file)
};

export type CaptureOptions = {
	dir: string;
	fs?: CaptureFs;
	now?: () => number;
	keep?: number;
	/** Called for a failed write, delete or folder scan (at most once per 10 s); never thrown. */
	onError?: (err: unknown) => void;
};

type Entry = { t: number; dial: number; fg?: string; bg?: string };

export class CaptureRecorder {
	private readonly dir: string;
	private readonly fs: CaptureFs;
	private readonly now: () => number;
	private readonly keep: number;
	private readonly onError: (err: unknown) => void;
	private queue: Promise<void> = Promise.resolve();
	private pending = 0;
	/** File names on disk, oldest first; null until the folder has been scanned. */
	private ring: string[] | null = null;
	private next = 0;
	private lastErrorAt = -Infinity;

	constructor(opts: CaptureOptions) {
		this.dir = opts.dir;
		this.fs = opts.fs ?? nodeFs;
		this.now = opts.now ?? Date.now;
		this.keep = opts.keep ?? CAPTURE_KEEP;
		this.onError = opts.onError ?? (() => {});
	}

	/** A sink that sends, then records the payload it sent. */
	wrap(dial: number, sink: FeedbackSink): FeedbackSink {
		return (payload) => {
			const result = sink(payload);
			this.record(dial, payload);
			return result;
		};
	}

	/** Queues one payload for writing and returns at once. Only `fg` and `bg` are kept. */
	record(dial: number, payload: Record<string, string>): void {
		const entry: Entry = { t: this.now(), dial };
		if (payload.fg !== undefined) entry.fg = payload.fg;
		if (payload.bg !== undefined) entry.bg = payload.bg;
		if (this.pending >= MAX_PENDING) {
			this.report(new Error("capture is falling behind; frame dropped"));
			return;
		}
		this.pending++;
		this.queue = this.queue
			.then(() => this.write(entry))
			.catch((err: unknown) => this.report(err))
			.finally(() => this.pending--);
	}

	/** Resolves once every queued write and delete has finished. */
	flush(): Promise<void> {
		return this.queue;
	}

	private async write(entry: Entry): Promise<void> {
		const ring = this.ring ?? (await this.scan());
		const name = captureName(this.next++, entry.dial);
		await this.fs.writeFile(path.join(this.dir, name), JSON.stringify(entry));
		ring.push(name);
		await this.prune(ring);
	}

	/** Creates the folder, then carries on numbering after any captures already in it. */
	private async scan(): Promise<string[]> {
		await this.fs.mkdir(this.dir, { recursive: true });
		const found = (await this.fs.readdir(this.dir))
			.map((name) => ({ name, parsed: parseCaptureName(name) }))
			.filter((f): f is { name: string; parsed: { n: number; dial: number } } => f.parsed !== null)
			.sort((a, b) => a.parsed.n - b.parsed.n);
		this.next = found.length > 0 ? found[found.length - 1].parsed.n + 1 : 0;
		this.ring = found.map((f) => f.name);
		await this.prune(this.ring);
		return this.ring;
	}

	private async prune(ring: string[]): Promise<void> {
		while (ring.length > this.keep) {
			const old = ring.shift()!;
			await this.fs.unlink(path.join(this.dir, old)).catch((err: unknown) => this.report(err));
		}
	}

	private report(err: unknown): void {
		const t = this.now();
		if (t - this.lastErrorAt < ERROR_LOG_MS) return;
		this.lastErrorAt = t;
		try {
			this.onError(err);
		} catch {
			// A failing logger must not break the chain.
		}
	}
}
