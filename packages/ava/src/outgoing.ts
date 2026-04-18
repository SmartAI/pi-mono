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

/**
 * Scan BOTH `<threadDir>/outgoing/` and `<threadDir>/worktree/outgoing/`
 * for attachable artifacts. Two paths because:
 *   - The scheduler and some skills use the thread-level dir.
 *   - Coding agents whose cwd is the worktree naturally write to
 *     `./outgoing` which resolves to the worktree-level dir.
 * Existed-as-a-bug for a while; this scan just accepts both now. Declared
 * attachments in the JSON contract are still the primary, authoritative
 * source — this scan is a fallback safety net.
 */
export async function scanOutgoing(threadDirAbs: string, capBytes: number): Promise<OutgoingScanResult> {
	const candidates = [join(threadDirAbs, "outgoing"), join(threadDirAbs, "worktree", "outgoing")];
	const attached: OutgoingFile[] = [];
	const overflow: OutgoingFile[] = [];
	const seenPaths = new Set<string>();
	const seenFilenames = new Set<string>();
	let running = 0;
	for (const outDir of candidates) {
		if (!existsSync(outDir)) continue;
		const entries = (await readdir(outDir, { withFileTypes: true })).filter(
			(e) => e.isFile() && !REPLY_BODY_FILENAME_RX.test(e.name),
		);
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const e of entries) {
			const path = join(outDir, e.name);
			if (seenPaths.has(path) || seenFilenames.has(e.name)) continue;
			seenPaths.add(path);
			seenFilenames.add(e.name);
			const bytes = (await stat(path)).size;
			const file: OutgoingFile = { filename: e.name, path, bytes };
			if (running + bytes <= capBytes) {
				attached.push(file);
				running += bytes;
			} else {
				overflow.push(file);
			}
		}
	}
	return { attached, overflow };
}

/**
 * Clear both the thread-level and worktree-level outgoing dirs (and
 * ensure both exist). Run at the start of each agent round so stale
 * files from a prior run don't leak into the next reply.
 */
export async function clearOutgoing(threadDirAbs: string): Promise<void> {
	const targets = [join(threadDirAbs, "outgoing"), join(threadDirAbs, "worktree", "outgoing")];
	for (const outDir of targets) {
		if (!existsSync(outDir)) {
			// Only mkdir the thread-level dir; worktree may not exist yet
			// on very first turn. The worktree dir gets auto-created when
			// the agent writes to it.
			if (outDir === targets[0]) await mkdir(outDir, { recursive: true });
			continue;
		}
		const entries = await readdir(outDir, { withFileTypes: true });
		await Promise.all(entries.filter((e) => e.isFile()).map((e) => unlink(join(outDir, e.name))));
	}
}
