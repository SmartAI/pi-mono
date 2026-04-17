import { existsSync } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface OutgoingFile {
	filename: string;
	path: string;
	bytes: number;
}

export interface OutgoingScanResult {
	attached: OutgoingFile[];
	overflow: OutgoingFile[];
}

// Common filenames agents tend to dump "a copy of the email reply" into.
// These are the reply body itself, not an attachment — skip so the reply
// doesn't end up attached to its own email.
const REPLY_BODY_FILENAME_RX = /^(reply|message|email|draft|response|body|answer)\.(txt|md|eml|html?)$/i;

export async function scanOutgoing(threadDirAbs: string, capBytes: number): Promise<OutgoingScanResult> {
	const outDir = join(threadDirAbs, "outgoing");
	if (!existsSync(outDir)) return { attached: [], overflow: [] };
	const entries = (await readdir(outDir, { withFileTypes: true })).filter(
		(e) => e.isFile() && !REPLY_BODY_FILENAME_RX.test(e.name),
	);
	entries.sort((a, b) => a.name.localeCompare(b.name));
	const attached: OutgoingFile[] = [];
	const overflow: OutgoingFile[] = [];
	let running = 0;
	for (const e of entries) {
		const path = join(outDir, e.name);
		const bytes = (await stat(path)).size;
		const file: OutgoingFile = { filename: e.name, path, bytes };
		if (running + bytes <= capBytes) {
			attached.push(file);
			running += bytes;
		} else {
			overflow.push(file);
		}
	}
	return { attached, overflow };
}

export async function clearOutgoing(threadDirAbs: string): Promise<void> {
	const outDir = join(threadDirAbs, "outgoing");
	if (!existsSync(outDir)) {
		await mkdir(outDir, { recursive: true });
		return;
	}
	const entries = await readdir(outDir, { withFileTypes: true });
	await Promise.all(entries.filter((e) => e.isFile()).map((e) => unlink(join(outDir, e.name))));
}
