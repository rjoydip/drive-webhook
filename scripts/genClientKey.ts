import { logger } from "../src/utils";

// Update or add a key
function updateEnvValue(content: string, key: string, value: string): string {
	const regex = new RegExp(`^${key}=.*$`, "m");
	if (regex.test(content)) {
		return content.replace(regex, `${key}=${value}`);
	}
	return `${content}\n${key}=${value}`;
}

async function main() {
	const clientKey = Bun.randomUUIDv7();
	logger.log("🔑 Generated Webhook AUTH Client Key:", clientKey);

	// Read the .env file
	const envFile = Bun.file("./.env");
	const content = await envFile.text();

	const updated = updateEnvValue(
		content,
		"WEBHOOK_AUTH_CLIENT_KEY",
		`"${clientKey}"`,
	);
	logger.log("✍️ Updated .env file with new client key.");

	// Write back to the file
	await Bun.write(".env", updated);
}

main().catch((error) => {
	logger.error("❌ Error generating client key:", error);
	process.exit(1);
});
