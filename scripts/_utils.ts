import { Signale } from "signale";
import type { OAuthSecrets } from "../src/types";

export const interactive = new Signale({
	interactive: true,
	scope: "interactive",
});

export const textCyan = Bun.color("#4bcffa", "ansi");
export const textGreen = Bun.color("#0be881", "ansi");
export const textWhite = Bun.color("white", "ansi");
export const SECRET_PATH = "./client_secret.json";

export async function loadOAuthSecrets(
	secretPath: string,
): Promise<OAuthSecrets> {
	return Bun.file(secretPath).json();
}
