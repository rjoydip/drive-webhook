import type { MiddlewareHandler } from "hono";

type RateLimitOptions = {
	windowMs: number;
	max: number;
	keyPrefix?: string;
};

export function rateLimit({
	windowMs,
	max,
	keyPrefix = "ratelimit",
}: RateLimitOptions): MiddlewareHandler {
	return async (c, next) => {
		const ip =
			c.req.header("cf-connecting-ip") ??
			c.req.header("x-forwarded-for") ??
			"unknown";

		const route = c.req.path;
		const key = `${keyPrefix}:${ip}:${route}`;
		const now = Date.now();

		const existing = (await c.env.drive_kv.get(key, "json")) as {
			count: number;
			resetAt: number;
		} | null;

		// Helper: KV TTL must be >= 60
		const ttl = (ms: number) => Math.max(Math.ceil(ms / 1000), 60);

		if (existing && now < existing.resetAt) {
			if (existing.count >= max) {
				return c.json(
					{
						message: "Too many requests",
						retryAfter: Math.ceil((existing.resetAt - now) / 1000),
					},
					429,
				);
			}

			existing.count += 1;

			await c.env.drive_kv.put(key, JSON.stringify(existing), {
				expirationTtl: ttl(existing.resetAt - now),
			});
		} else {
			const resetAt = now + windowMs;

			await c.env.drive_kv.put(key, JSON.stringify({ count: 1, resetAt }), {
				expirationTtl: ttl(windowMs),
			});
		}

		return await next();
	};
}
