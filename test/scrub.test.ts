import { PNG } from "pngjs";
import { checkCommitEmails, denylistWarnings, parseDenylist, scanPng, scanText } from "../scripts/scrub";

// Sensitive-looking inputs are assembled at runtime so this file scans clean.
const ip = (...parts: Array<string | number>) => parts.join(".");
const jwt = ["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJ" + "zdWIiOiJzcGluZGxlIn0", "c2lnbmF0dXJlMTIzNDU2"].join(".");
const webhook = "/api/" + "webhook/abc";

describe("scanText generic tier", () => {
	it.each([
		["a 10/8 address", ip(10, 0, 0, 5)],
		["a 172.16/12 address", ip(172, 20, 1, 1)],
		["the start of 172.16/12", ip(172, 16, 0, 1)],
		["the end of 172.16/12", ip(172, 31, 255, 254)],
		["a 192.168/16 address", ip(192, 168, 0, 7)],
		["an address that only resembles the documented example", ip(192, 168, 1, 100)]
	])("flags private IPv4 %s", (_name, value) => {
		const hits = scanText(`host = ${value}:8123`, "a.ts", []);
		expect(hits).toEqual([{ file: "a.ts", line: 1, pattern: "private-ipv4" }]);
	});

	it("does not flag public addresses, version strings or the 172.x non-private range", () => {
		const text = [ip(8, 8, 8, 8), ip(172, 32, 0, 1), ip(172, 15, 0, 1), ip(1, 10, 0, 0, 5), "v10.1.2", ip(110, 1, 2, 3)].join("\n");
		expect(scanText(text, "a.ts", [])).toEqual([]);
	});

	it("allows the documentation example 192.168.1.10", () => {
		expect(scanText("e.g. http://192.168.1.10:8123", "README.md", [])).toEqual([]);
	});

	it("flags a realistic JWT but not a bare eyJ prefix", () => {
		expect(scanText(`Bearer ${jwt}`, "a.ts", [])).toEqual([{ file: "a.ts", line: 1, pattern: "jwt" }]);
		expect(scanText("auth eyJabc failed", "a.ts", [])).toEqual([]);
	});

	it("flags a JWT glued to other word characters or URL-encoding", () => {
		const headerOnly = "eyJ" + "hbGciOiJIUzI1NiJ9" + ".c2lnbmF0dXJlMTIzNDU2";
		expect(scanText("token%3D" + headerOnly, "a.ts", []).map((h) => h.pattern)).toEqual(["jwt"]);
		expect(scanText("x_" + headerOnly, "a.ts", []).map((h) => h.pattern)).toEqual(["jwt"]);
	});

	it("flags a two-segment JWT-shaped string", () => {
		const two = jwt.split(".").slice(0, 2).join(".");
		expect(scanText(two, "a.ts", []).map((h) => h.pattern)).toEqual(["jwt"]);
	});

	it("flags webhook API paths", () => {
		expect(scanText(`fetch("${webhook}")`, "a.ts", [])).toEqual([{ file: "a.ts", line: 1, pattern: "webhook-path" }]);
	});

	it("reports the right line numbers across CRLF and LF", () => {
		const text = ["clean", `x ${ip(10, 1, 2, 3)}`, "clean", webhook].join("\r\n");
		expect(scanText(text, "a.ts", []).map((h) => h.line)).toEqual([2, 4]);
	});
});

describe("scanText local tier", () => {
	it("flags extra literals case-insensitively and treats them literally", () => {
		const hits = scanText("hello Secret-Host.example and a.c+(x)", "a.ts", ["secret-host.EXAMPLE", "a.c+(x)"]);
		expect(hits).toEqual([
			{ file: "a.ts", line: 1, pattern: "local-denylist#1" },
			{ file: "a.ts", line: 1, pattern: "local-denylist#2" }
		]);
	});

	it("ignores blank extra literals", () => {
		expect(scanText("anything at all", "a.ts", ["", "   "])).toEqual([]);
	});

	it("never echoes the literal in the hit pattern", () => {
		const [hit] = scanText("find the needle here", "a.ts", ["needle"]);
		expect(hit.pattern).not.toContain("needle");
	});

	it("allows the copyright holder even when a denylist line is a part of the name", () => {
		const text = "Copyright (c) 2026 Dustin Szabo";
		expect(scanText(text, "LICENSE", ["Dustin", "szabo"])).toEqual([]);
		expect(scanText("copyright dustin szabo", "LICENSE", ["Dustin"])).toEqual([]);
	});

	it("still flags the same literal outside the copyright holder's name", () => {
		const hits = scanText("Dustin Szabo wrote this for Dustin", "a.ts", ["Dustin"]);
		expect(hits).toHaveLength(1);
		const solo = scanText("ask Dustin", "a.ts", ["Dustin"]);
		expect(solo).toHaveLength(1);
	});
});

describe("denylistWarnings", () => {
	it("is quiet for a normal file", () => {
		expect(denylistWarnings("one\n", ["one"])).toEqual([]);
	});

	it("warns about a UTF-16 file and about an empty one", () => {
		const utf16 = "o\0n\0e\0";
		expect(denylistWarnings(utf16, parseDenylist(utf16))).toEqual([expect.stringContaining("NUL")]);
		expect(denylistWarnings("# only a comment\n", [])).toEqual([expect.stringContaining("no entries")]);
	});
});

describe("parseDenylist", () => {
	it("drops comments, blanks and surrounding whitespace", () => {
		expect(parseDenylist("# comment\n\n  one  \r\ntwo\n   \n#three\n")).toEqual(["one", "two"]);
	});
});

function pngWithChunk(type: string | null): Uint8Array {
	const bytes = new Uint8Array(PNG.sync.write(new PNG({ width: 2, height: 2 })));
	if (!type) return bytes;
	// Splice a chunk (length, type, data, dummy CRC) in right after IHDR (8 signature + 25 IHDR bytes).
	const data = new TextEncoder().encode("Comment\0hello");
	const chunk = new Uint8Array(12 + data.length);
	const view = new DataView(chunk.buffer);
	view.setUint32(0, data.length);
	chunk.set(new TextEncoder().encode(type), 4);
	chunk.set(data, 8);
	const out = new Uint8Array(bytes.length + chunk.length);
	out.set(bytes.subarray(0, 33), 0);
	out.set(chunk, 33);
	out.set(bytes.subarray(33), 33 + chunk.length);
	return out;
}

describe("scanPng", () => {
	it("passes a pngjs-encoded image", () => {
		expect(scanPng(pngWithChunk(null))).toEqual([]);
	});

	it.each(["tEXt", "iTXt", "zTXt"])("flags a %s chunk", (type) => {
		expect(scanPng(pngWithChunk(type))).toEqual([type]);
	});

	it("flags bytes that are not a PNG", () => {
		expect(scanPng(new Uint8Array([1, 2, 3]))).toEqual(["not-a-png"]);
	});
});

describe("checkCommitEmails", () => {
	const noreply = "VagueDustin@users.noreply.github.com";
	const record = (sha: string, ae: string, ce: string, trailers = "") => `\x1e${sha}\t${ae}\t${ce}\t${trailers}\n`;

	it("accepts noreply authors and committers with no co-authors", () => {
		expect(checkCommitEmails(record("aaaaaaa", noreply, noreply))).toEqual([]);
	});

	it("accepts users.noreply.github.com co-authors, including several trailers", () => {
		const one = record("aaaaaaa", noreply, noreply, "Pal <1234+pal@users.noreply.github.com>\n");
		expect(checkCommitEmails(one)).toEqual([]);
		const many = record("bbbbbbb", noreply, noreply, "Pal <1234+pal@users.noreply.github.com>\x1fOther <5678+other@users.noreply.github.com>\n");
		expect(checkCommitEmails(many)).toEqual([]);
	});

	it("rejects co-authors without a GitHub noreply address", () => {
		const vendor = "noreply@" + "anthropic.com";
		const plain = "noreply@" + "github.com";
		for (const email of [vendor, plain, "someone@" + "example.org"]) {
			const hits = checkCommitEmails(record("aaaaaaa", noreply, noreply, `Co <${email}>\n`));
			expect(hits.map((h) => h.pattern)).toEqual(["commit aaaaaaa: Co-Authored-By email"]);
			expect(JSON.stringify(hits)).not.toContain(email);
		}
	});

	it("flags a real author email, committer email and co-author email without echoing them", () => {
		const real = "someone@" + "example.org";
		const log = [
			record("aaaaaaa", real, noreply),
			record("bbbbbbb", noreply, real),
			record("ccccccc", noreply, noreply, `Other <${real}>\n`)
		].join("");
		const hits = checkCommitEmails(log);
		expect(hits.map((h) => h.pattern)).toEqual(["commit aaaaaaa: author email", "commit bbbbbbb: committer email", "commit ccccccc: Co-Authored-By email"]);
		expect(JSON.stringify(hits)).not.toContain(real);
	});

	it("accepts GitHub's web-flow committer but not as an author", () => {
		const web = "noreply@" + "github.com";
		expect(checkCommitEmails(record("aaaaaaa", noreply, web))).toEqual([]);
		expect(checkCommitEmails(record("bbbbbbb", web, noreply)).map((h) => h.pattern)).toEqual(["commit bbbbbbb: author email"]);
	});

	it("flags a Co-Authored-By value with no parseable email and compares case-insensitively", () => {
		const none = checkCommitEmails(record("aaaaaaa", noreply, noreply, "Pal without an address\n"));
		expect(none.map((h) => h.pattern)).toEqual(["commit aaaaaaa: Co-Authored-By email"]);
		const mixed = record("bbbbbbb", noreply, noreply, "Pal <1+pal@Users.NoReply.GitHub.com>\n");
		expect(checkCommitEmails(mixed)).toEqual([]);
		const oneBad = record("ccccccc", noreply, noreply, "Pal <1+pal@users.noreply.github.com>\x1fNo address\n");
		expect(checkCommitEmails(oneBad)).toHaveLength(1);
	});

	it("handles an empty history", () => {
		expect(checkCommitEmails("")).toEqual([]);
	});
});
