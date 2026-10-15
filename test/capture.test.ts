import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CaptureRecorder, captureDirFor, captureName, parseCaptureName, type CaptureFs } from "../src/capture";

/** An in-memory folder: file name -> contents. */
class MemFs implements CaptureFs {
	files = new Map<string, string>();
	failWrites = false;
	mkdirs: string[] = [];
	constructor(readonly dir: string) {}
	async mkdir(dir: string): Promise<void> {
		this.mkdirs.push(dir);
	}
	async readdir(): Promise<string[]> {
		return [...this.files.keys()];
	}
	async writeFile(file: string, data: string): Promise<void> {
		if (this.failWrites) throw new Error("disk full");
		this.files.set(path.basename(file), data);
	}
	async unlink(file: string): Promise<void> {
		this.files.delete(path.basename(file));
	}
	names(): string[] {
		return [...this.files.keys()].sort();
	}
}

const DIR = path.join("repo", "capture");

describe("capture names", () => {
	it("zero-pads the counter and appends the dial index", () => {
		expect(captureName(0, 0)).toBe("000000-0.json");
		expect(captureName(123, 2)).toBe("000123-2.json");
		expect(captureName(1234567, 3)).toBe("1234567-3.json");
	});

	it("parses its own names and nothing else", () => {
		expect(parseCaptureName("000123-2.json")).toEqual({ n: 123, dial: 2 });
		expect(parseCaptureName("1234567-3.json")).toEqual({ n: 1234567, dial: 3 });
		expect(parseCaptureName("notes.txt")).toBeNull();
		expect(parseCaptureName("000123-2.json.tmp")).toBeNull();
		expect(parseCaptureName("abc-1.json")).toBeNull();
	});
});

describe("CaptureRecorder", () => {
	it("writes each payload with a timestamp and the dial, only the keys the payload had", async () => {
		const mem = new MemFs(DIR);
		let t = 1000;
		const rec = new CaptureRecorder({ dir: DIR, fs: mem, now: () => t });
		rec.record(1, { fg: "data:image/svg+xml,A", bg: "data:image/png;base64,B" });
		t = 1100;
		rec.record(0, { fg: "data:image/svg+xml,C" });
		t = 1200;
		rec.record(0, { bg: "data:image/png;base64,D", other: "ignored" });
		await rec.flush();
		expect(mem.mkdirs).toEqual([DIR]);
		expect(mem.names()).toEqual(["000000-1.json", "000001-0.json", "000002-0.json"]);
		expect(JSON.parse(mem.files.get("000000-1.json")!)).toEqual({ t: 1000, dial: 1, fg: "data:image/svg+xml,A", bg: "data:image/png;base64,B" });
		expect(JSON.parse(mem.files.get("000001-0.json")!)).toEqual({ t: 1100, dial: 0, fg: "data:image/svg+xml,C" });
		expect(JSON.parse(mem.files.get("000002-0.json")!)).toEqual({ t: 1200, dial: 0, bg: "data:image/png;base64,D" });
	});

	it("keeps a ring of the newest files, deleting the oldest", async () => {
		const mem = new MemFs(DIR);
		const rec = new CaptureRecorder({ dir: DIR, fs: mem, now: () => 0, keep: 3 });
		for (let i = 0; i < 5; i++) rec.record(i % 2, { fg: `f${i}` });
		await rec.flush();
		expect(mem.names()).toEqual(["000002-0.json", "000003-1.json", "000004-0.json"]);
	});

	it("keeps 600 by default", async () => {
		const mem = new MemFs(DIR);
		const rec = new CaptureRecorder({ dir: DIR, fs: mem, now: () => 0 });
		for (let i = 0; i < 605; i++) {
			rec.record(0, { fg: "x" });
			if (i % 50 === 49) await rec.flush();
		}
		await rec.flush();
		const names = mem.names();
		expect(names).toHaveLength(600);
		expect(names[0]).toBe("000005-0.json");
		expect(names[599]).toBe("000604-0.json");
	});

	it("drops payloads beyond 100 queued behind a slow disk, and says so", async () => {
		const mem = new MemFs(DIR);
		const errors: unknown[] = [];
		const rec = new CaptureRecorder({ dir: DIR, fs: mem, now: () => 0, onError: (e) => errors.push(e) });
		for (let i = 0; i < 105; i++) rec.record(0, { fg: "x" });
		await rec.flush();
		expect(mem.files.size).toBe(100);
		expect(errors).toHaveLength(1);
		expect(String(errors[0])).toContain("falling behind");
		rec.record(0, { fg: "y" });
		await rec.flush();
		expect(mem.names().at(-1)).toBe("000100-0.json");
	});

	it("continues numbering after the files already there and counts them in the ring", async () => {
		const mem = new MemFs(DIR);
		mem.files.set("000007-0.json", "{}");
		mem.files.set("000009-1.json", "{}");
		mem.files.set("README.txt", "not a capture");
		const rec = new CaptureRecorder({ dir: DIR, fs: mem, now: () => 0, keep: 3 });
		rec.record(2, { fg: "a" });
		rec.record(2, { fg: "b" });
		await rec.flush();
		expect(mem.names()).toEqual(["000009-1.json", "000010-2.json", "000011-2.json", "README.txt"]);
	});

	it("never blocks: record returns before anything is written", () => {
		const mem = new MemFs(DIR);
		const rec = new CaptureRecorder({ dir: DIR, fs: mem, now: () => 0 });
		rec.record(0, { fg: "a" });
		expect(mem.files.size).toBe(0);
	});

	it("swallows write errors, reports them, and keeps recording", async () => {
		const mem = new MemFs(DIR);
		const errors: unknown[] = [];
		const rec = new CaptureRecorder({ dir: DIR, fs: mem, now: () => 0, onError: (e) => errors.push(e) });
		mem.failWrites = true;
		rec.record(0, { fg: "a" });
		await rec.flush();
		expect(errors).toHaveLength(1);
		expect(String(errors[0])).toContain("disk full");
		mem.failWrites = false;
		rec.record(0, { fg: "b" });
		await rec.flush();
		expect(mem.names()).toEqual(["000001-0.json"]);
	});

	it("reports at most one error per 10 s", async () => {
		const mem = new MemFs(DIR);
		mem.failWrites = true;
		let t = 0;
		const errors: unknown[] = [];
		const rec = new CaptureRecorder({ dir: DIR, fs: mem, now: () => t, onError: (e) => errors.push(e) });
		for (let i = 0; i < 5; i++) rec.record(0, { fg: "a" });
		await rec.flush();
		expect(errors).toHaveLength(1);
		t = 10_000;
		rec.record(0, { fg: "a" });
		await rec.flush();
		expect(errors).toHaveLength(2);
	});

	it("wrap sends first, then records what was sent", async () => {
		const mem = new MemFs(DIR);
		const rec = new CaptureRecorder({ dir: DIR, fs: mem, now: () => 5 });
		const sent: Record<string, string>[] = [];
		const sink = rec.wrap(3, (p) => {
			sent.push(p);
			return Promise.resolve("ok");
		});
		await expect(sink({ fg: "a" })).resolves.toBe("ok");
		await rec.flush();
		expect(sent).toEqual([{ fg: "a" }]);
		expect(JSON.parse(mem.files.get("000000-3.json")!)).toEqual({ t: 5, dial: 3, fg: "a" });
	});

	it("wrap records nothing when the sink throws", async () => {
		const mem = new MemFs(DIR);
		const rec = new CaptureRecorder({ dir: DIR, fs: mem, now: () => 0 });
		const sink = rec.wrap(0, () => {
			throw new Error("gone");
		});
		expect(() => sink({ fg: "a" })).toThrow("gone");
		await rec.flush();
		expect(mem.files.size).toBe(0);
	});
});

describe("CaptureRecorder on disk", () => {
	let tmp: string | undefined;
	afterEach(() => {
		if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
		tmp = undefined;
	});

	it("creates the folder and writes real files with node's fs by default", async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-capture-"));
		const dir = path.join(tmp, "capture");
		const rec = new CaptureRecorder({ dir, now: () => 42, keep: 2 });
		for (let i = 0; i < 3; i++) rec.record(1, { fg: `f${i}` });
		await rec.flush();
		expect(fs.readdirSync(dir).sort()).toEqual(["000001-1.json", "000002-1.json"]);
		expect(JSON.parse(fs.readFileSync(path.join(dir, "000002-1.json"), "utf8"))).toEqual({ t: 42, dial: 1, fg: "f2" });
	});
});

describe("captureDirFor", () => {
	const repo = path.resolve("some", "repo");
	const pluginDir = path.join(repo, "com.example.sdPlugin");

	it("is the capture folder beside the plugin folder, after resolving links", () => {
		const linked = path.resolve("appdata", "Plugins", "com.example.sdPlugin");
		const sys = { realpath: (p: string) => (p === linked ? pluginDir : p), exists: (p: string) => p === path.join(repo, "package.json") };
		expect(captureDirFor(linked, sys)).toBe(path.join(repo, "capture"));
	});

	it("is null when the plugin folder is not inside a checkout (no package.json beside it)", () => {
		const sys = { realpath: (p: string) => p, exists: () => false };
		expect(captureDirFor(pluginDir, sys)).toBeNull();
	});
});
