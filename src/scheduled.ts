import type { ScheduledEvent } from "@cloudflare/workers-types";
import type { ExecutionContext } from "hono";
import { renewDriveWatchIfNeeded } from "./helper";
import type { Bindings } from "./types";

export default {
	async scheduled(_: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
		ctx.waitUntil(renewDriveWatchIfNeeded(env));
	},
};
