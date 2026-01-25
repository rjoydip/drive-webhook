import { Signale } from "signale";

export const interactive = new Signale({
	interactive: true,
	scope: "interactive",
});

export const textCyan = Bun.color("#4bcffa", "ansi");
export const textGreen = Bun.color("#0be881", "ansi");
export const textWhite = Bun.color("white", "ansi");
