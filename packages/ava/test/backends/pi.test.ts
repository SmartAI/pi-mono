import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiBackend } from "../../src/backends/pi.js";

describe("PiBackend", () => {
	let dir: string;
	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "ava-pi-"));
		await mkdir(join(dir, "threads", "T-1"), { recursive: true });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("passes --session pointing at the in-tree pi-session.jsonl and forwards cwd via workdir", async () => {
		const b = new PiBackend();
		let argvSeen: string[] = [];
		let optsSeen: { workdir?: string } = {};
		await b.run({
			threadId: "T-1",
			cwdInContainer: "/workspace/threads/T-1/worktree",
			containerDataDir: dir,
			systemPrompt: "",
			userPrompt: "hi",
			dataDir: dir,
			timeoutMs: 5_000,
			sandboxExec: async (argv, opts) => {
				argvSeen = argv;
				optsSeen = opts;
				return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
			},
		});
		expect(argvSeen).toContain("--session");
		const sessionIdx = argvSeen.indexOf("--session");
		expect(argvSeen[sessionIdx + 1]).toMatch(/pi-session\.jsonl$/);
		expect(argvSeen).not.toContain("--cwd");
		expect(optsSeen.workdir).toBe("/workspace/threads/T-1/worktree");
	});

	it("classifies pi-ai rate-limit stderr", () => {
		const b = new PiBackend();
		expect(
			b.classify({
				exitCode: 1,
				stdout: "",
				stderr: "pi-ai: rate_limit_error (429)",
				durationMs: 1,
				timedOut: false,
			}),
		).toBe("rate-limit");
	});
});
