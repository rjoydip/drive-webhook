import { getAccessTokens } from "../src/helper";
import { logger } from "../src/utils";

async function main() {
	const authCode = process.argv[2] ?? process.env.AUTH_CODE;

	if (!authCode) {
		throw new Error(
			"Authorization code is required as a command-line argument.",
		);
	}

	const tokens = await getAccessTokens(authCode);
	logger.log("✅ Generated OAuth Tokens:", tokens);
}

main().catch((error) => {
	logger.error("❌ Error generating tokens:", error);
	process.exit(1);
});
