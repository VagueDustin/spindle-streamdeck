import { pairKey, pairWideDials, type WideSlot } from "../../src/wide/pairing";

const slot = (id: string, column: number, device = "dev1"): WideSlot => ({ id, device, column });
const ids = (r: ReturnType<typeof pairWideDials>) => ({
	pairs: r.pairs.map((p) => [p.left.id, p.right.id]),
	unpaired: r.unpaired.map((s) => s.id)
});

describe("pairWideDials", () => {
	it("pairs neighbours from the left, whatever order they appeared in", () => {
		expect(ids(pairWideDials([slot("d", 3), slot("a", 0), slot("c", 2), slot("b", 1)]))).toEqual({
			pairs: [
				["a", "b"],
				["c", "d"]
			],
			unpaired: []
		});
	});

	it("pairs a lone 1+2 and leaves a third dial over", () => {
		expect(ids(pairWideDials([slot("b", 1), slot("c", 2)]))).toEqual({ pairs: [["b", "c"]], unpaired: [] });
		expect(ids(pairWideDials([slot("a", 0), slot("b", 1), slot("c", 2)]))).toEqual({ pairs: [["a", "b"]], unpaired: ["c"] });
	});

	it("never pairs across a gap or across devices", () => {
		expect(ids(pairWideDials([slot("a", 0), slot("c", 2)]))).toEqual({ pairs: [], unpaired: ["a", "c"] });
		expect(ids(pairWideDials([slot("a", 0, "dev1"), slot("b", 1, "dev2")]))).toEqual({ pairs: [], unpaired: ["a", "b"] });
	});

	it("gives an unchanged pair the same key", () => {
		const p = pairWideDials([slot("a", 0), slot("b", 1)]).pairs[0];
		expect(pairKey(p)).toBe("a|b");
	});
});
