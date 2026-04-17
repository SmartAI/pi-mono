import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "../src/worktree.js";

function sh(cmd: string, cwd: string): void {
	execSync(cmd, { cwd, stdio: "pipe" });
}

describe("WorktreeManager", () => {
	let dir: string;
	let bareRepo: string;
	let threadsRoot: string;
	let wm: WorktreeManager;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "ava-wt-"));
		const seed = join(dir, "seed");
		await mkdir(seed);
		sh("git init -b main", seed);
		sh("git config user.email 'test@example.com'", seed);
		sh("git config user.name 'Test'", seed);
		await writeFile(join(seed, "README.md"), "seed\n");
		sh("git add .", seed);
		sh("git commit -m initial", seed);

		bareRepo = join(dir, "repo.git");
		sh(`git clone --bare "${seed}" "${bareRepo}"`, dir);

		threadsRoot = join(dir, "threads");
		await mkdir(threadsRoot);
		wm = new WorktreeManager({ bareRepoPath: bareRepo, threadsRoot });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("creates a worktree for a new thread", async () => {
		const path = await wm.ensureWorktree("T-abc1234");
		expect(path).toBe(join(threadsRoot, "T-abc1234", "worktree"));
		expect(existsSync(join(path, ".git"))).toBe(true);
		expect(existsSync(join(path, "README.md"))).toBe(true);
	});

	it("reuses an existing worktree on the second call", async () => {
		const p1 = await wm.ensureWorktree("T-abc1234");
		const p2 = await wm.ensureWorktree("T-abc1234");
		expect(p1).toBe(p2);
	});

	it("cleanup removes the worktree but keeps branch reachable", async () => {
		await wm.ensureWorktree("T-xyz00000");
		await wm.cleanupThread("T-xyz00000");
		expect(existsSync(join(threadsRoot, "T-xyz00000", "worktree"))).toBe(false);
		const branches = execSync(`git -C "${bareRepo}" branch --list "ava/*"`, { encoding: "utf-8" });
		expect(branches).toContain("ava/T-xyz00");
	});
});
