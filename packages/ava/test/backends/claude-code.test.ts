import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeBackend } from "../../src/backends/claude-code.js";

describe("ClaudeCodeBackend", () => {
	let dir: string;
	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "ava-cc-"));
		await mkdir(join(dir, "threads", "T-1"), { recursive: true });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("classifies a known rate-limit stderr as rate-limit", () => {
		const b = new ClaudeCodeBackend();
		expect(
			b.classify({
				exitCode: 1,
				stdout: "",
				stderr: "Error: rate limit exceeded. retry after 300s",
				durationMs: 1,
				timedOut: false,
			}),
		).toBe("rate-limit");
	});

	it("classifies an auth-expired stderr as auth", () => {
		const b = new ClaudeCodeBackend();
		expect(
			b.classify({
				exitCode: 1,
				stdout: "",
				stderr: "Authentication token expired. Please re-login.",
				durationMs: 1,
				timedOut: false,
			}),
		).toBe("auth");
	});

	it("classifies exit 0 as ok", () => {
		const b = new ClaudeCodeBackend();
		expect(b.classify({ exitCode: 0, stdout: "done", stderr: "", durationMs: 1, timedOut: false })).toBe("ok");
	});

	it("classifies other nonzero exits as crash", () => {
		const b = new ClaudeCodeBackend();
		expect(b.classify({ exitCode: 9, stdout: "", stderr: "segfault", durationMs: 1, timedOut: false })).toBe("crash");
	});

	it("on first run, generates a UUID, writes it to the pointer, and passes --session-id <uuid>", async () => {
		const b = new ClaudeCodeBackend();
		const sessionFile = join(dir, "threads", "T-1", "claude-session-id");
		let capturedArgv: string[] = [];
		const result = await b.run({
			threadId: "T-1",
			cwdInContainer: "/workspace/threads/T-1/worktree",
			prompt: "hello",
			dataDir: dir,
			timeoutMs: 5_000,
			sandboxExec: async (argv) => {
				capturedArgv = argv;
				return { exitCode: 0, stdout: "final reply text", stderr: "", durationMs: 1, timedOut: false };
			},
		});
		expect(result.exitCode).toBe(0);
		const storedId = (await readFile(sessionFile, "utf-8")).trim();
		expect(storedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(capturedArgv).toContain("--session-id");
		expect(capturedArgv).toContain(storedId);
	});

	it("on subsequent runs, passes the stored session id via --resume", async () => {
		const b = new ClaudeCodeBackend();
		const sessionFile = join(dir, "threads", "T-1", "claude-session-id");
		await writeFile(sessionFile, "existing-id");
		let capturedArgv: string[] = [];
		const result = await b.run({
			threadId: "T-1",
			cwdInContainer: "/workspace/threads/T-1/worktree",
			prompt: "second message",
			dataDir: dir,
			timeoutMs: 5_000,
			sandboxExec: async (argv) => {
				capturedArgv = argv;
				return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, timedOut: false };
			},
		});
		expect(result.exitCode).toBe(0);
		expect(capturedArgv).toContain("--resume");
		expect(capturedArgv).toContain("existing-id");
	});

	it("forwards the worktree path to sandboxExec as workdir, not as a CLI flag", async () => {
		const b = new ClaudeCodeBackend();
		let capturedOpts: { workdir?: string } = {};
		let capturedArgv: string[] = [];
		await b.run({
			threadId: "T-1",
			cwdInContainer: "/workspace/threads/T-1/worktree",
			prompt: "hi",
			dataDir: dir,
			timeoutMs: 5_000,
			sandboxExec: async (argv, opts) => {
				capturedArgv = argv;
				capturedOpts = opts;
				return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
			},
		});
		expect(capturedOpts.workdir).toBe("/workspace/threads/T-1/worktree");
		expect(capturedArgv).not.toContain("--cwd");
	});
});
