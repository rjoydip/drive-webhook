import { getAccessTokens } from "../src/helper";
import { logger } from "../src/utils";
import { loadOAuthSecrets, SECRET_PATH } from "./_utils";

async function main() {
	const authCode = process.argv[2] ?? process.env.AUTH_CODE;
	const {
		web: { client_id, client_secret, redirect_uris },
	} = await loadOAuthSecrets(SECRET_PATH);

	if (!authCode) {
		throw new Error(
			"Authorization code is required as a command-line argument.",
		);
	}

	const tokens = await getAccessTokens(
		{
			client_id,
			client_secret,
			redirect_uris,
		},
		authCode,
	);
	logger.log("✅ Generated OAuth Tokens:", tokens);
}

main().catch((error) => {
	logger.error("❌ Error generating tokens:", error);
	process.exit(1);
});
