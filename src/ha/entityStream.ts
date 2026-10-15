import type { RawEntity } from "./playerState";

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Applies one `subscribe_entities` event payload (`{a?, c?, r?}`) to the store.
 * `a` replaces entities, `c` patches known entities (`+` merges state/attributes, `-` removes attributes),
 * `r` removes entities. Returns the ids that changed. Never throws; malformed input is ignored.
 */
export function applyCompressed(store: Map<string, RawEntity>, msg: unknown): Set<string> {
	const changed = new Set<string>();
	if (!isDict(msg)) {
		return changed;
	}
	if (isDict(msg.a)) {
		for (const [id, entry] of Object.entries(msg.a)) {
			if (isDict(entry) && typeof entry.s === "string") {
				store.set(id, { state: entry.s, attributes: isDict(entry.a) ? { ...entry.a } : {} });
				changed.add(id);
			}
		}
	}
	if (isDict(msg.c)) {
		for (const [id, diff] of Object.entries(msg.c)) {
			const current = store.get(id);
			if (current && isDict(diff)) {
				const next = patch(current, diff);
				if (next) {
					store.set(id, next);
					changed.add(id);
				}
			}
		}
	}
	if (Array.isArray(msg.r)) {
		for (const id of msg.r) {
			if (typeof id === "string" && store.delete(id)) {
				changed.add(id);
			}
		}
	}
	return changed;
}

/** Returns a patched copy of `current`, or null when the diff changes nothing. lc/lu/c bookkeeping keys are ignored. */
function patch(current: RawEntity, diff: Dict): RawEntity | null {
	let state = current.state;
	let attributes = current.attributes;
	let changed = false;

	const plus = diff["+"];
	if (isDict(plus)) {
		if (typeof plus.s === "string" && plus.s !== state) {
			state = plus.s;
			changed = true;
		}
		if (isDict(plus.a) && Object.keys(plus.a).length > 0) {
			attributes = { ...attributes, ...plus.a };
			changed = true;
		}
	}

	const minus = diff["-"];
	if (isDict(minus) && Array.isArray(minus.a)) {
		for (const key of minus.a) {
			if (typeof key === "string" && Object.hasOwn(attributes, key)) {
				if (attributes === current.attributes) {
					attributes = { ...attributes };
				}
				delete attributes[key];
				changed = true;
			}
		}
	}

	return changed ? { state, attributes } : null;
}

/**
 * Applies a `state_changed` event to the store (fallback path when `subscribe_entities` is unavailable).
 * Takes the event `data` object `{entity_id, new_state, old_state}`; a full `{event_type, data}` event is also
 * accepted and unwrapped. A null `new_state` deletes the entity. Returns the ids that changed; never throws.
 */
export function applyStateChanged(store: Map<string, RawEntity>, event: unknown): Set<string> {
	const changed = new Set<string>();
	if (!isDict(event)) {
		return changed;
	}
	const data = isDict(event.data) ? event.data : event;
	const newState = data.new_state;
	const id = typeof data.entity_id === "string" && data.entity_id
		? data.entity_id
		: isDict(newState) && typeof newState.entity_id === "string" && newState.entity_id
			? newState.entity_id
			: null;
	if (id === null) {
		return changed;
	}
	if (newState === null) {
		if (store.delete(id)) {
			changed.add(id);
		}
	} else if (isDict(newState) && typeof newState.state === "string") {
		store.set(id, { state: newState.state, attributes: isDict(newState.attributes) ? { ...newState.attributes } : {} });
		changed.add(id);
	}
	return changed;
}
