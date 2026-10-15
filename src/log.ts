const REDACTED = "‹redacted›";

/** Replaces every occurrence of each non-empty secret with a placeholder. Secrets are matched literally. */
export function redact(text: string, secrets: Array<string | undefined>): string {
	let out = text;
	for (const secret of secrets) {
		if (secret) {
			out = out.split(secret).join(REDACTED);
		}
	}
	return out;
}
