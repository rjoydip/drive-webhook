import { Signale } from "signale";
import { name } from "../package.json";

export const KV_NS = "drive_kv";
export const TEMP_EXT = ".tmp";

export const logger = new Signale({
	scope: name,
});
