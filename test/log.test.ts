import { redact } from "../src/log";

test("redact", () => {
	expect(redact("auth eyJabc failed for eyJabc", ["eyJabc", undefined, ""])).toBe("auth ‹redacted› failed for ‹redacted›");
});

test("redact returns text unchanged without usable secrets", () => {
	expect(redact("nothing to hide", [])).toBe("nothing to hide");
	expect(redact("nothing to hide", [undefined, ""])).toBe("nothing to hide");
});

test("redact treats secrets literally, not as regex", () => {
	expect(redact("tok a.c+(x) and abc", ["a.c+(x)"])).toBe("tok ‹redacted› and abc");
	expect(redact("cost $& $1 here", ["$&", "$1"])).toBe("cost ‹redacted› ‹redacted› here");
});

test("redact handles several secrets", () => {
	expect(redact("one two one", ["one", "two"])).toBe("‹redacted› ‹redacted› ‹redacted›");
});
