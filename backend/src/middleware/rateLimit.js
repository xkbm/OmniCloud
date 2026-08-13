const buckets = new Map();

function now() {
	return Date.now();
}

function cleanup(currentTime) {
	for (const [key, bucket] of buckets) {
		if (bucket.resetAt <= currentTime) {
			buckets.delete(key);
		}
	}
}

export function createRateLimiter({ windowMs, max, keyGenerator = (req) => req.ip || 'unknown', message = 'Too many requests. Please try again later.' }) {
	return (req, res, next) => {
		const currentTime = now();
		if (buckets.size > 1000) cleanup(currentTime);

		const key = String(keyGenerator(req) || 'unknown');
		let bucket = buckets.get(key);

		if (!bucket || bucket.resetAt <= currentTime) {
			bucket = { count: 0, resetAt: currentTime + windowMs };
			buckets.set(key, bucket);
		}

		bucket.count += 1;
		res.setHeader('X-RateLimit-Limit', String(max));
		res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));

		if (bucket.count > max) {
			const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1000));
			res.setHeader('Retry-After', String(retryAfter));
			return res.status(429).json({ error: message });
		}

		next();
	};
}
