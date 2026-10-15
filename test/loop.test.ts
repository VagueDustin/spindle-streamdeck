import { afterEach, describe, expect, it, vi } from "vitest";
import { FrameLoop, type LoopController } from "../src/loop";

type Pri = "none" | "half" | "full";

/** A scripted stand-in for DialController: urgent until its first frame goes out, like the real one. */
class FakeCtl implements LoopController {
	pri: Pri = "full";
	isUrgent = true;
	ticks: number[] = [];
	frames = 0;
	constructor(readonly id: string) {}
	tick(t: number): void {
		this.ticks.push(t);
	}
	priority(): Pri {
		return this.pri;
	}
	urgent(): boolean {
		return this.isUrgent;
	}
	frame(): Record<string, string> | null {
		if (this.pri === "none" && !this.isUrgent) return null;
		this.frames++;
		this.isUrgent = false;
		return { fg: this.id };
	}
}

/** Drives a loop by hand: injected interval capture and a manual clock. */
const harness = (opts: { onError?: (id: string, err: unknown) => void } = {}) => {
	let clock = 1_000_000;
	let beat: (() => void) | null = null;
	const handle = { h: 1 } as unknown as ReturnType<typeof setInterval>;
	const setIntervalImpl = vi.fn((fn: () => void) => {
		beat = fn;
		return handle;
	}) as unknown as typeof setInterval;
	const clearIntervalImpl = vi.fn() as unknown as typeof clearInterval;
	const loop = new FrameLoop({ now: () => clock, setIntervalImpl, clearIntervalImpl, ...opts });
	const sent: string[] = [];
	const sinkFor = (id: string) => (p: Record<string, string>) => {
		sent.push(`${id}:${p.fg}`);
	};
	const add = (ctl: FakeCtl) => loop.add(ctl.id, ctl as never, sinkFor(ctl.id));
	/** Advances the clock and fires one heartbeat; returns this beat's sends. */
	const step = (ms = 100): string[] => {
		clock += ms;
		const before = sent.length;
		beat!();
		return sent.slice(before);
	};
	return {
		loop,
		sent,
		add,
		step,
		sinkFor,
		setIntervalImpl,
		clearIntervalImpl,
		handle,
		setClock: (t: number) => (clock = t),
		clock: () => clock
	};
};

const run = (h: ReturnType<typeof harness>, n: number) => Array.from({ length: n }, () => h.step());

afterEach(() => {
	vi.useRealTimers();
});

describe("FrameLoop budget", () => {
	it("ticks every controller on every heartbeat with the loop clock", () => {
		const h = harness();
		const a = new FakeCtl("a");
		const b = new FakeCtl("b");
		b.pri = "none";
		b.isUrgent = false;
		h.add(a);
		h.add(b);
		h.loop.start();
		run(h, 3);
		expect(a.ticks).toEqual([1_000_100, 1_000_200, 1_000_300]);
		expect(b.ticks).toEqual(a.ticks);
	});

	it("never sends more than once per tick and at most 10 in ten ticks", () => {
		const h = harness();
		for (const id of ["a", "b", "c", "d"]) h.add(new FakeCtl(id));
		h.loop.start();
		const beats = run(h, 10);
		for (const b of beats) expect(b.length).toBeLessThanOrEqual(1);
		expect(h.sent.length).toBe(10);
	});

	it("sends a lone full dial every tick", () => {
		const h = harness();
		h.add(new FakeCtl("a"));
		h.loop.start();
		expect(run(h, 10).map((b) => b.length)).toEqual(Array(10).fill(1));
	});

	it("sends a lone half dial every second tick", () => {
		const h = harness();
		const a = new FakeCtl("a");
		a.pri = "half";
		h.add(a);
		h.loop.start();
		const counts = run(h, 10).map((b) => b.length);
		// First frame goes out at once, then every second tick.
		expect(counts).toEqual([1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
	});

	it("alternates two full dials, five each per second", () => {
		const h = harness();
		const a = new FakeCtl("a");
		const b = new FakeCtl("b");
		h.add(a);
		h.add(b);
		h.loop.start();
		run(h, 10);
		expect(a.frames).toBe(5);
		expect(b.frames).toBe(5);
		expect(h.sent.slice(0, 4)).toEqual(["a:a", "b:b", "a:a", "b:b"]);
	});

	it("gives a full dial at least twice the sends of a half dial without starving it", () => {
		const h = harness();
		const full = new FakeCtl("full");
		const half = new FakeCtl("half");
		half.pri = "half";
		h.add(full);
		h.add(half);
		h.loop.start();
		run(h, 40);
		expect(half.frames).toBeGreaterThan(0);
		expect(full.frames).toBeGreaterThanOrEqual(2 * half.frames);
		expect(full.frames + half.frames).toBe(40);
	});

	it("keeps full dials at about half the sends against five half dials, and still serves every half dial", () => {
		const h = harness();
		const full = new FakeCtl("full");
		const halves = Array.from({ length: 5 }, (_, i) => new FakeCtl(`h${i}`));
		for (const c of [full, ...halves]) {
			c.isUrgent = false;
			if (c !== full) c.pri = "half";
			h.add(c);
		}
		h.loop.start();
		run(h, 20);
		expect(full.frames).toBeGreaterThanOrEqual(9);
		for (const c of halves) expect(c.frames).toBeGreaterThanOrEqual(1);
		expect(full.frames + halves.reduce((n, c) => n + c.frames, 0)).toBe(20);
	});

	it("serves a pending bg update before every other dial", () => {
		const h = harness();
		const a = new FakeCtl("a");
		const b = new FakeCtl("b");
		const c = new FakeCtl("c");
		[a, b, c].forEach((x) => h.add(x));
		h.loop.start();
		run(h, 6);
		c.isUrgent = true; // a bg update is now pending on c
		const next = h.step();
		expect(next).toEqual(["c:c"]);
	});

	it("serves a newly added dial on the next tick", () => {
		const h = harness();
		h.add(new FakeCtl("a"));
		h.add(new FakeCtl("b"));
		h.loop.start();
		run(h, 5);
		h.add(new FakeCtl("late"));
		expect(h.step()).toEqual(["late:late"]);
	});

	it("serves several urgent dials oldest-sent first", () => {
		const h = harness();
		const a = new FakeCtl("a");
		const b = new FakeCtl("b");
		const c = new FakeCtl("c");
		a.isUrgent = false; // a is only full-rate, so b and c go first and a last
		[a, b, c].forEach((x) => h.add(x));
		h.loop.start();
		expect(run(h, 3).flat()).toEqual(["b:b", "c:c", "a:a"]);
		a.isUrgent = b.isUrgent = c.isUrgent = true;
		// Insertion order is a, b, c; oldest-sent is b, c, a.
		expect(run(h, 3).flat()).toEqual(["b:b", "c:c", "a:a"]);
	});

	it("never sends a none dial unless its first frame is pending", () => {
		const h = harness();
		const idle = new FakeCtl("idle");
		idle.pri = "none";
		idle.isUrgent = false;
		h.add(idle);
		h.loop.start();
		run(h, 5);
		expect(idle.frames).toBe(0);
		expect(h.sent).toEqual([]);

		const fresh = new FakeCtl("fresh");
		fresh.pri = "none";
		h.add(fresh);
		expect(h.step()).toEqual(["fresh:fresh"]);
		expect(run(h, 5).flat()).toEqual([]);
	});

	it("falls through to the next candidate when a frame comes back null", () => {
		const h = harness();
		const a = new FakeCtl("a");
		const b = new FakeCtl("b");
		a.frame = () => null;
		h.add(a);
		h.add(b);
		h.loop.start();
		expect(run(h, 4).flat()).toEqual(["b:b", "b:b", "b:b", "b:b"]);
	});

	it("stops sending to a removed dial", () => {
		const h = harness();
		const a = new FakeCtl("a");
		const b = new FakeCtl("b");
		h.add(a);
		h.add(b);
		h.loop.start();
		run(h, 4);
		h.loop.remove("a");
		const aFrames = a.frames;
		const ticks = a.ticks.length;
		expect(run(h, 6).flat()).toEqual(Array(6).fill("b:b"));
		expect(a.frames).toBe(aFrames);
		expect(a.ticks.length).toBe(ticks);
	});

	it("replaces a dial added under an existing id", () => {
		const h = harness();
		const old = new FakeCtl("x");
		const fresh = new FakeCtl("x");
		h.add(old);
		h.loop.start();
		run(h, 2);
		h.add(fresh);
		expect(h.step()).toEqual(["x:x"]);
		expect(fresh.frames).toBe(1);
		expect(old.frames).toBe(2);
		expect(old.ticks.length).toBe(2);
	});
});

describe("FrameLoop removal during a beat", () => {
	it("is safe to remove a dial from inside a sink", () => {
		const h = harness();
		const b = new FakeCtl("b");
		h.loop.add("a", new FakeCtl("a") as never, () => h.loop.remove("b"));
		h.add(b);
		h.loop.start();
		expect(() => h.step()).not.toThrow();
		expect(run(h, 3).flat()).toEqual([]);
		expect(b.frames).toBe(0);
	});

	it("gives no frame to a dial removed by another dial's tick in the same beat", () => {
		const h = harness();
		const a = new FakeCtl("a");
		const b = new FakeCtl("b");
		a.tick = () => h.loop.remove("b");
		// b is first in line (older lastSent is irrelevant: it is simply listed first).
		h.add(b);
		h.add(a);
		h.loop.start();
		expect(h.step()).toEqual(["a:a"]);
		expect(b.frames).toBe(0);
	});

	it("gives no frame to a dial replaced earlier in the same beat", () => {
		const h = harness();
		const old = new FakeCtl("x");
		const fresh = new FakeCtl("x");
		const a = new FakeCtl("a");
		a.tick = () => h.add(fresh);
		h.add(old);
		h.add(a);
		h.loop.start();
		// The replacement was not ticked this beat, so it waits; the old one must not be served.
		expect(h.step()).toEqual(["a:a"]);
		expect(old.frames).toBe(0);
		expect(fresh.frames).toBe(0);
		expect(h.step()).toEqual(["x:x"]);
	});
});

describe("FrameLoop timing", () => {
	it("start is idempotent and stop clears the interval once", () => {
		const h = harness();
		h.add(new FakeCtl("a"));
		h.loop.start();
		h.loop.start();
		expect(h.setIntervalImpl).toHaveBeenCalledTimes(1);
		expect(vi.mocked(h.setIntervalImpl).mock.calls[0]![1]).toBe(100);
		h.loop.stop();
		h.loop.stop();
		expect(h.clearIntervalImpl).toHaveBeenCalledTimes(1);
		expect(h.clearIntervalImpl).toHaveBeenCalledWith(h.handle);
	});

	it("can start again after a stop", () => {
		const h = harness();
		h.add(new FakeCtl("a"));
		h.loop.start();
		h.loop.stop();
		h.loop.start();
		expect(h.setIntervalImpl).toHaveBeenCalledTimes(2);
		expect(h.step().length).toBe(1);
	});

	it("sends a half dial again within two beats after a stop and start", () => {
		const h = harness();
		const a = new FakeCtl("a");
		a.pri = "half";
		h.add(a);
		h.loop.start();
		run(h, 20);
		h.loop.stop();
		h.loop.start();
		const counts = run(h, 2).map((b) => b.length);
		expect(counts.reduce((x, y) => x + y, 0)).toBeGreaterThanOrEqual(1);
	});

	it("honours a custom interval", () => {
		const setIntervalImpl = vi.fn(() => 1 as never) as unknown as typeof setInterval;
		new FrameLoop({ intervalMs: 50, now: () => 0, setIntervalImpl }).start();
		expect(vi.mocked(setIntervalImpl).mock.calls[0]![1]).toBe(50);
	});

	it("does one tick and one send for a late heartbeat, without catching up", () => {
		const h = harness();
		const a = new FakeCtl("a");
		h.add(a);
		h.loop.start();
		run(h, 3);
		const ticksBefore = a.ticks.length;
		const late = h.step(450); // four intervals went by
		expect(late.length).toBe(1);
		expect(a.ticks.length).toBe(ticksBefore + 1);
		expect(h.step().length).toBe(1);
	});

	it("keeps half-rate cadence after a late heartbeat", () => {
		const h = harness();
		const a = new FakeCtl("a");
		a.pri = "half";
		h.add(a);
		h.loop.start();
		run(h, 2);
		h.step(750);
		expect(run(h, 6).map((b) => b.length)).toEqual([0, 1, 0, 1, 0, 1]);
	});

	it("does not accumulate drift when heartbeats jitter around the interval", () => {
		const h = harness();
		h.add(new FakeCtl("a"));
		h.add(new FakeCtl("b"));
		h.loop.start();
		const jitter = [104, 97, 109, 91, 101, 99, 103, 98, 105, 95];
		const beats = jitter.map((ms) => h.step(ms));
		for (const b of beats) expect(b.length).toBe(1);
		expect(h.sent.length).toBe(10);
	});

	it("survives the clock stepping backwards", () => {
		const h = harness();
		const a = new FakeCtl("a");
		a.pri = "half";
		h.add(a);
		h.loop.start();
		run(h, 4);
		h.setClock(h.clock() - 60_000);
		const counts = run(h, 6).map((b) => b.length);
		expect(counts.reduce((x, y) => x + y, 0)).toBe(3);
		expect(Math.max(...counts)).toBe(1);
	});

	it("runs on the default timers: ten sends in one second", () => {
		vi.useFakeTimers();
		const loop = new FrameLoop();
		const sent: string[] = [];
		for (const id of ["a", "b"]) loop.add(id, new FakeCtl(id) as never, (p) => void sent.push(p.fg!));
		loop.start();
		vi.advanceTimersByTime(1000);
		expect(sent.length).toBe(10);
		loop.stop();
		vi.advanceTimersByTime(1000);
		expect(sent.length).toBe(10);
	});
});

describe("FrameLoop fault isolation", () => {
	it("keeps going when the sink throws, and counts it as the tick's send", () => {
		const errors: Array<[string, unknown]> = [];
		const h = harness({ onError: (id, err) => errors.push([id, err]) });
		const a = new FakeCtl("a");
		const b = new FakeCtl("b");
		const boom = new Error("socket closed");
		h.loop.add("a", a as never, () => {
			throw boom;
		});
		h.add(b);
		h.loop.start();
		// Tick 0: a is served first and its sink throws; b must not get a second send this tick.
		expect(h.step()).toEqual([]);
		expect(b.frames).toBe(0);
		expect(errors).toEqual([["a", boom]]);
		expect(h.step()).toEqual(["b:b"]);
	});

	it("catches a rejecting sink promise and keeps running", async () => {
		const errors: Array<[string, unknown]> = [];
		const h = harness({ onError: (id, err) => errors.push([id, err]) });
		const boom = new Error("rejected");
		let calls = 0;
		h.loop.add("a", new FakeCtl("a") as never, () => {
			calls++;
			return Promise.reject(boom);
		});
		h.loop.start();
		h.step();
		await Promise.resolve();
		await Promise.resolve();
		expect(errors).toEqual([["a", boom]]);
		h.step();
		expect(calls).toBe(2);
	});

	it("skips a controller whose tick throws and serves the rest", () => {
		const errors: string[] = [];
		const h = harness({ onError: (id) => errors.push(id) });
		const bad = new FakeCtl("bad");
		bad.tick = () => {
			throw new Error("tick");
		};
		const good = new FakeCtl("good");
		h.add(bad);
		h.add(good);
		h.loop.start();
		expect(run(h, 3).flat()).toEqual(["good:good", "good:good", "good:good"]);
		expect(bad.frames).toBe(0);
		expect(errors).toEqual(["bad", "bad", "bad"]);
	});

	it("skips a controller whose priority or frame throws", () => {
		const errors: string[] = [];
		const h = harness({ onError: (id) => errors.push(id) });
		const badPri = new FakeCtl("badPri");
		badPri.isUrgent = false;
		badPri.priority = () => {
			throw new Error("priority");
		};
		const badFrame = new FakeCtl("badFrame");
		badFrame.frame = () => {
			throw new Error("frame");
		};
		const good = new FakeCtl("good");
		[badPri, badFrame, good].forEach((x) => h.add(x));
		h.loop.start();
		// The throwing frame() does not spend the budget, so the next candidate is tried in the same tick.
		expect(run(h, 3).flat()).toEqual(["good:good", "good:good", "good:good"]);
		expect(errors).toContain("badPri");
		expect(errors).toContain("badFrame");
	});

	it("defaults onError to a no-op", () => {
		const h = harness();
		const bad = new FakeCtl("bad");
		bad.tick = () => {
			throw new Error("tick");
		};
		h.add(bad);
		h.loop.start();
		expect(() => h.step()).not.toThrow();
	});
});
