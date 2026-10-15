// The one shared ticker (spec 4.3): every dial is ticked each heartbeat, but at most ONE
// setFeedback goes out per heartbeat across all dials, i.e. 10 sends/sec at 100 ms. The loop
// only needs these four methods from a dial, so tests hand it plain fakes.
import type { DialController } from "./dial/controller";

export type LoopController = Pick<DialController, "tick" | "priority" | "frame" | "urgent">;
/** A returned promise (setFeedback is async in the SDK) has its rejection caught by the loop. */
export type FeedbackSink = (payload: Record<string, string>) => void | Promise<unknown>;

export type FrameLoopOptions = {
	/** Heartbeat and budget period; one send per heartbeat. Default 100. */
	intervalMs?: number;
	/**
	 * The clock. It MUST be the same clock the controllers were built with (their `deps.now`):
	 * controllers stamp input with their `now` and compare it against the `t` this loop passes to
	 * `tick(t)`. Defaults to `Date.now`, which is what Task 12 gives the controllers too.
	 */
	now?: () => number;
	setIntervalImpl?: typeof setInterval;
	clearIntervalImpl?: typeof clearInterval;
	/** Logging hook for a dial that threw or whose sink failed; the loop carries on regardless. */
	onError?: (id: string, err: unknown) => void;
};

/** A half-rate dial is eligible every second tick (about 5 fps)... */
const HALF_EVERY_TICKS = 2;
/** ...but yields to full-rate dials until it has waited this long (a floor of 2.5 fps). */
const HALF_STARVED_TICKS = 4;
/** "Never sent": older than any real age. */
const NEVER = -1e9;

type Entry = { id: string; ctl: LoopController; sink: FeedbackSink; lastSent: number };
type Candidate = { entry: Entry; rank: number; half: boolean };

export class FrameLoop {
	private readonly intervalMs: number;
	private readonly now: () => number;
	private readonly setIntervalImpl: typeof setInterval | undefined;
	private readonly clearIntervalImpl: typeof clearInterval | undefined;
	private readonly onError: (id: string, err: unknown) => void;
	/** Insertion-ordered, which is also the tie-break order. */
	private readonly dials = new Map<string, Entry>();
	private handle: ReturnType<typeof setInterval> | null = null;
	private t0 = 0;
	private tickNo = 0;
	/** The previous send went to a half-rate dial, so full-rate dials go next (see `candidates`). */
	private lastSendWasHalf = false;

	constructor(opts: FrameLoopOptions = {}) {
		this.intervalMs = opts.intervalMs ?? 100;
		this.now = opts.now ?? Date.now;
		this.setIntervalImpl = opts.setIntervalImpl;
		this.clearIntervalImpl = opts.clearIntervalImpl;
		this.onError = opts.onError ?? (() => {});
	}

	/** Adding under an existing id replaces that dial. A new dial is served on the next tick. */
	add(id: string, ctl: LoopController, sink: FeedbackSink): void {
		this.dials.delete(id);
		this.dials.set(id, { id, ctl, sink, lastSent: NEVER });
	}

	remove(id: string): void {
		this.dials.delete(id);
	}

	start(): void {
		if (this.handle !== null) return;
		this.t0 = this.now();
		this.tickNo = 0;
		this.lastSendWasHalf = false;
		// tickNo restarts at 0, so ages measured against the old run would be hugely negative.
		for (const e of this.dials.values()) e.lastSent = NEVER;
		this.handle = (this.setIntervalImpl ?? setInterval)(() => this.beat(), this.intervalMs);
	}

	stop(): void {
		if (this.handle === null) return;
		(this.clearIntervalImpl ?? clearInterval)(this.handle);
		this.handle = null;
	}

	/**
	 * One heartbeat. The tick number comes from elapsed time on the monotonic-by-assumption clock, so
	 * jitter does not accumulate; a late heartbeat does one tick and skips the ones it missed.
	 */
	private beat(): void {
		const t = this.now();
		// Rounded, not floored: setInterval may fire a millisecond early, which must not repeat a tick number.
		let tickNo = Math.round((t - this.t0) / this.intervalMs);
		if (tickNo < this.tickNo) {
			// The wall clock stepped back: carry on from the current tick number instead of stalling.
			this.t0 = t - this.tickNo * this.intervalMs;
			tickNo = this.tickNo;
		}
		this.tickNo = tickNo;

		const live: Entry[] = [];
		for (const e of this.dials.values()) {
			try {
				e.ctl.tick(t);
				live.push(e);
			} catch (err) {
				this.onError(e.id, err);
			}
		}

		for (const { entry, half } of this.candidates(live, t, tickNo)) {
			// A dial removed or replaced earlier in this beat (by another dial's tick, priority or frame) gets nothing.
			if (this.dials.get(entry.id) !== entry) continue;
			let payload: Record<string, string> | null;
			try {
				payload = entry.ctl.frame(t);
			} catch (err) {
				this.onError(entry.id, err);
				continue;
			}
			if (!payload) continue;
			entry.lastSent = tickNo;
			this.lastSendWasHalf = half;
			this.send(entry, payload);
			return; // the budget for this tick is spent
		}
	}

	/**
	 * Who may send this tick, best first:
	 * 0. urgent dials (first frame or pending bg), oldest send first;
	 * 1. half-rate dials that have waited past the starvation limit, oldest first, unless the previous
	 *    send was already a half-rate dial, in which case they drop to rank 3: full-rate dials then get
	 *    at least every other tick, while half-rate dials still get the rest and never starve outright;
	 * 2. full-rate dials, oldest first (this is the round-robin);
	 * 3. half-rate dials that are merely due, oldest first.
	 * Insertion order breaks remaining ties (the sort is stable).
	 */
	private candidates(live: Entry[], t: number, tickNo: number): Candidate[] {
		const out: Candidate[] = [];
		for (const entry of live) {
			try {
				if (entry.ctl.urgent()) {
					out.push({ entry, rank: 0, half: false });
					continue;
				}
				const pri = entry.ctl.priority(t);
				const age = tickNo - entry.lastSent;
				if (pri === "full") out.push({ entry, rank: 2, half: false });
				else if (pri === "half" && age >= HALF_EVERY_TICKS) {
					const starved = age >= HALF_STARVED_TICKS && !this.lastSendWasHalf;
					out.push({ entry, rank: starved ? 1 : 3, half: true });
				}
			} catch (err) {
				this.onError(entry.id, err);
			}
		}
		return out.sort((a, b) => a.rank - b.rank || a.entry.lastSent - b.entry.lastSent);
	}

	/** Fire and forget: a failing sink must not break the loop, and the budget is spent either way. */
	private send(entry: Entry, payload: Record<string, string>): void {
		try {
			const result = entry.sink(payload);
			if (result && typeof result.then === "function") {
				result.then(undefined, (err: unknown) => this.onError(entry.id, err));
			}
		} catch (err) {
			this.onError(entry.id, err);
		}
	}
}
