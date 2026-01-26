import type { MiddlewareHandler } from "hono";
import { logger } from "./utils";

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

const GOOGLE_IP_RANGES = [
	// Common Google Workspace / APIs ranges (partial example)
	"35.190.0.0/17",
	"64.233.160.0/19",
	"66.102.0.0/20",
	"74.125.0.0/16",
	"108.177.8.0/21",
	"172.217.0.0/19",
	"216.58.192.0/19",
];

const ipInCidr = (ip: string, cidr: string) => {
	// Simple CIDR check (Cloudflare Workers compatible)
	const [range, bits] = cidr.split("/");
	const mask = ~(2 ** (32 - Number(bits)) - 1);

	const ipToInt = (ip: string) =>
		ip.split(".").reduce((acc, oct) => (acc << 8) + +oct, 0);

	return (ipToInt(ip) & mask) === (ipToInt(range) & mask);
};

export const allowGoogleOnly: MiddlewareHandler = async (c, next) => {
	const ip =
		c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For");

	if (!ip) {
		return c.json({ message: "IP address missing" }, 403);
	}

	const allowed = GOOGLE_IP_RANGES.some((cidr) => ipInCidr(ip, cidr));

	if (!allowed) {
		logger.warn(`🚫 Blocked non-Google IP: ${ip}`);
		return c.json({ message: "Forbidden" }, 403);
	}

	await next();
};
