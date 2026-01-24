import { getAccessTokens } from "../src/helper";
import { logger } from "../src/utils";

async function main() {
  const tokens = await getAccessTokens();
  logger.log("✅ Generated OAuth Tokens:", tokens);
}

main().catch((error) => {
  logger.error("❌ Error generating tokens:", error);
  process.exit(1);
});
