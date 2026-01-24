import { generateAuthUrl } from "../src/helper";
import { logger } from "../src/utils";

async function main() {
  const authUrl = generateAuthUrl();
  logger.log(`🔗 Generated Auth URL: ${authUrl}`);
}

main().catch((error) => {
  logger.error("❌ Error generating Auth URL:", error);
  process.exit(1);
});
