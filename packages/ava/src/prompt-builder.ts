const DIRECTIVE_STRIP = /@ava:use=[a-z-]+/gi;

export interface BuildPromptInput {
	isFirstRun: boolean;
	newestMessage: { from: string; subject: string; bodyText: string };
	worktreePath: string;
	outgoingPath: string;
	globalMemory: string;
	threadMemory: string;
}

export function buildPrompt(input: BuildPromptInput): string {
	const sections: string[] = [];
	sections.push(
		`You are Ava, an engineering teammate for ActualVoice. You are replying to an email from ${input.newestMessage.from}. Your response will be sent as an email reply, so write it as a human-readable message (plain text, code fences ok). Working directory: ${input.worktreePath}. Files you want attached to your reply must be written to ${input.outgoingPath}/.`,
	);
	if (input.isFirstRun) {
		if (input.globalMemory) sections.push(`## Global memory\n${input.globalMemory}`);
		if (input.threadMemory) sections.push(`## Thread memory\n${input.threadMemory}`);
	}
	const cleanBody = input.newestMessage.bodyText.replace(DIRECTIVE_STRIP, "").trim();
	sections.push(
		`## Incoming email\nSubject: ${input.newestMessage.subject}\nFrom: ${input.newestMessage.from}\n\n${cleanBody}`,
	);
	return sections.join("\n\n");
}
