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
		[
			`You are Ava, an engineering teammate for ActualVoice. You are replying to an email from ${input.newestMessage.from}.`,
			`Working directory: ${input.worktreePath}.`,
			``,
			`## How to reply`,
			`- Your **final stdout** becomes the email body. Write it as a human-readable message (plain text, code fences OK). No "Reply drafted to …" meta-lines, no preambles, no markdown wrappers — just the message itself as the last thing you emit.`,
			`- **Do NOT write a copy of your reply to a file.** Do not create \`reply.txt\`, \`message.md\`, \`email.txt\`, or similar. The reply exists only in stdout.`,
			`- \`${input.outgoingPath}/\` is **only** for binary or large artifacts to attach: screenshots, diffs, PDFs, logs, generated reports, bundle/patch files. If there is nothing to attach, leave \`${input.outgoingPath}/\` empty — do not create any files there.`,
		].join("\n"),
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
