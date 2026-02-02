import type { ScheduledEvent } from "@cloudflare/workers-types";
import type { ExecutionContext } from "hono";
import { renewDriveWatchIfNeeded } from "./helper";
import type { AppBindings } from "./types";

export default {
	async scheduled(_: ScheduledEvent, env: AppBindings, ctx: ExecutionContext) {
		ctx.waitUntil(renewDriveWatchIfNeeded(env));
	},
};
