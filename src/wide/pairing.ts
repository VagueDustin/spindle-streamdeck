// Which Wide dials form pairs: per device, by column, greedily from the left. A dial pairs only with
// its direct right-hand neighbour, so columns 0+1 and 2+3 pair, a lone 1+2 pairs, and a third Wide
// dial in a row is left over.

export type WideSlot = { id: string; device: string; column: number };
export type WidePair = { left: WideSlot; right: WideSlot };

export function pairWideDials(slots: Iterable<WideSlot>): { pairs: WidePair[]; unpaired: WideSlot[] } {
	const byDevice = new Map<string, WideSlot[]>();
	for (const s of slots) {
		const list = byDevice.get(s.device) ?? [];
		list.push(s);
		byDevice.set(s.device, list);
	}
	const pairs: WidePair[] = [];
	const unpaired: WideSlot[] = [];
	for (const list of byDevice.values()) {
		list.sort((a, b) => a.column - b.column);
		for (let i = 0; i < list.length; ) {
			const next = list[i + 1];
			if (next && next.column === list[i].column + 1) {
				pairs.push({ left: list[i], right: next });
				i += 2;
			} else {
				unpaired.push(list[i]);
				i += 1;
			}
		}
	}
	return { pairs, unpaired };
}

/** A stable key for a pair, so an unchanged pair keeps its controller across re-pairing. */
export const pairKey = (p: WidePair) => `${p.left.id}|${p.right.id}`;
