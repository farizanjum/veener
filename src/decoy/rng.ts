/** Deterministic seeded RNG (mulberry32) so template weaving is reproducible per seed. */
export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
	if (items.length === 0) throw new Error("pick from empty list");
	return items[Math.floor(rng() * items.length)];
}

export function pickSome<T>(rng: () => number, items: readonly T[], count: number): T[] {
	const copy = [...items];
	const out: T[] = [];
	while (out.length < count && copy.length > 0) {
		out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
	}
	return out;
}
