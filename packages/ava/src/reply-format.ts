const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
const MAX_LINE_CHARS = 2_000;
const MAX_TOTAL_LINES = 1_500;

export function normalizeReply(input: string): string {
	const noAnsi = input.replace(ANSI_REGEX, "");
	const linesIn = noAnsi.split("\n");
	const trimmedLines = linesIn.map((line) =>
		line.length > MAX_LINE_CHARS
			? line.slice(0, MAX_LINE_CHARS) +
				` [... 1 lines truncated — ${line.length - MAX_LINE_CHARS} chars removed ...]`
			: line,
	);
	if (trimmedLines.length <= MAX_TOTAL_LINES) return trimmedLines.join("\n");
	const head = trimmedLines.slice(0, Math.floor(MAX_TOTAL_LINES / 2));
	const tail = trimmedLines.slice(-Math.floor(MAX_TOTAL_LINES / 2));
	const removed = trimmedLines.length - head.length - tail.length;
	return [...head, `[... ${removed} lines truncated ...]`, ...tail].join("\n");
}
