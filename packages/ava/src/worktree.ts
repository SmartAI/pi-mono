import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface WorktreeManagerOpts {
	bareRepoPath: string;
	threadsRoot: string;
}

function branchFor(threadId: string): string {
	// Hex thread IDs (Gmail's) collapse safely to an 8-char prefix — still
	// distinct at the scale we run. Anything else (scheduled threads, manual
	// IDs) keeps its full name to avoid accidental collisions between
	// `sched-weekly-sync` and `sched-weekly-wrap`, which would both become
	// `sched-we` under the old prefix.
	return `ava/${/^[0-9a-f]+$/i.test(threadId) ? threadId.slice(0, 8) : threadId}`;
}

export class WorktreeManager {
	constructor(private opts: WorktreeManagerOpts) {}

	async ensureWorktree(threadId: string): Promise<string> {
		const wtPath = join(this.opts.threadsRoot, threadId, "worktree");
		const branch = branchFor(threadId);
		if (existsSync(wtPath)) return wtPath;
		// Self-heal against stale registry entries from a previously-deleted
		// worktree dir (e.g. manual rm -rf on ./data/threads/<tid>/). Without
		// this, `git worktree add -B` fails with "branch already used by
		// worktree at …" pointing at the missing path.
		await execFileP("git", ["-C", this.opts.bareRepoPath, "worktree", "prune"]);
		await execFileP("git", ["-C", this.opts.bareRepoPath, "worktree", "add", "-B", branch, wtPath]);
		return wtPath;
	}

	async cleanupThread(threadId: string): Promise<void> {
		const wtPath = join(this.opts.threadsRoot, threadId, "worktree");
		if (!existsSync(wtPath)) return;
		await execFileP("git", ["-C", this.opts.bareRepoPath, "worktree", "remove", "--force", wtPath]);
	}

	async fetch(): Promise<void> {
		await execFileP("git", ["-C", this.opts.bareRepoPath, "fetch", "--prune", "--all"]);
	}

	async prune(
		maxInactiveMs: number,
		store: { threadLastActivityMs: (id: string) => Promise<number>; listThreadIds: () => Promise<string[]> },
	): Promise<number> {
		const now = Date.now();
		let removed = 0;
		for (const tid of await store.listThreadIds()) {
			const wtPath = join(this.opts.threadsRoot, tid, "worktree");
			if (!existsSync(wtPath)) continue;
			const last = await store.threadLastActivityMs(tid);
			if (now - last > maxInactiveMs) {
				await this.cleanupThread(tid);
				removed++;
			}
		}
		return removed;
	}
}
