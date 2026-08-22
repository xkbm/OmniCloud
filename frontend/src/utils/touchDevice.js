let cached = null;

export function isCoarsePointerDevice() {
	if (cached === null) {
		cached = typeof window !== 'undefined'
			&& typeof window.matchMedia === 'function'
			&& window.matchMedia('(pointer: coarse)').matches;
	}
	return cached;
}
