import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexBackend } from "../../src/backends/codex.js";

describe("CodexBackend", () => {
	let dir: string;
	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "ava-cx-"));
		await mkdir(join(dir, "threads", "T-1"), { recursive: true });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("classifies rate-limit patterns from Codex", () => {
		const b = new CodexBackend();
		expect(
			b.classify({
				exitCode: 1,
				stdout: "",
				stderr: "429 Too Many Requests — quota exhausted",
				durationMs: 1,
				timedOut: false,
			}),
		).toBe("rate-limit");
	});

	it("classifies auth patterns from Codex", () => {
		const b = new CodexBackend();
		expect(
			b.classify({
				exitCode: 1,
				stdout: "",
				stderr: "401 Unauthorized: please login again",
				durationMs: 1,
				timedOut: false,
			}),
		).toBe("auth");
	});

	it("first run: extracts session id from JSONL stdout and persists it to pointer", async () => {
		const b = new CodexBackend();
		const sessionFile = join(dir, "threads", "T-1", "codex-session-id");
		const fakeJsonlStdout =
			'{"type":"session_started","session_id":"abcd1234-5678-90ef-1234-567890abcdef"}\n{"type":"message","content":"hi"}\n';
		await b.run({
			threadId: "T-1",
			cwdInContainer: "/workspace/threads/T-1/worktree",
			prompt: "hi",
			dataDir: dir,
			timeoutMs: 5_000,
			sandboxExec: async () => ({
				exitCode: 0,
				stdout: fakeJsonlStdout,
				stderr: "",
				durationMs: 1,
				timedOut: false,
			}),
		});
		expect((await readFile(sessionFile, "utf-8")).trim()).toBe("abcd1234-5678-90ef-1234-567890abcdef");
	});

	it("first-run argv is `codex exec` with --json, -m gpt-5.4, skip-perms, -o <file>, prompt last", async () => {
		const b = new CodexBackend();
		let argvSeen: string[] = [];
		await b.run({
			threadId: "T-1",
			cwdInContainer: "/workspace/threads/T-1/worktree",
			prompt: "hi",
			dataDir: dir,
			timeoutMs: 5_000,
			sandboxExec: async (argv) => {
				argvSeen = argv;
				return { exitCode: 0, stdout: '{"session_id":"x-y"}\n', stderr: "", durationMs: 1, timedOut: false };
			},
		});
		expect(argvSeen.slice(0, 2)).toEqual(["codex", "exec"]);
		expect(argvSeen).toContain("--json");
		expect(argvSeen).toContain("-m");
		expect(argvSeen).toContain("gpt-5.4");
		expect(argvSeen).toContain("--dangerously-bypass-approvals-and-sandbox");
		expect(argvSeen).toContain("-o");
		expect(argvSeen).not.toContain("-C");
		expect(argvSeen).not.toContain("--cd");
		expect(argvSeen[argvSeen.length - 1]).toBe("hi");
	});

	it("resume run: argv becomes `codex exec resume <uuid>` and stored id is used", async () => {
		const b = new CodexBackend();
		const sessionFile = join(dir, "threads", "T-1", "codex-session-id");
		await writeFile(sessionFile, "prev-uuid");
		let argvSeen: string[] = [];
		await b.run({
			threadId: "T-1",
			cwdInContainer: "/workspace/threads/T-1/worktree",
			prompt: "second",
			dataDir: dir,
			timeoutMs: 5_000,
			sandboxExec: async (argv) => {
				argvSeen = argv;
				return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
			},
		});
		expect(argvSeen.slice(0, 4)).toEqual(["codex", "exec", "resume", "prev-uuid"]);
		expect(argvSeen[argvSeen.length - 1]).toBe("second");
	});

	it("forwards the worktree path to sandboxExec as workdir", async () => {
		const b = new CodexBackend();
		let optsSeen: { workdir?: string } = {};
		await b.run({
			threadId: "T-1",
			cwdInContainer: "/workspace/threads/T-1/worktree",
			prompt: "hi",
			dataDir: dir,
			timeoutMs: 5_000,
			sandboxExec: async (_argv, opts) => {
				optsSeen = opts;
				return { exitCode: 0, stdout: '{"session_id":"x"}\n', stderr: "", durationMs: 1, timedOut: false };
			},
		});
		expect(optsSeen.workdir).toBe("/workspace/threads/T-1/worktree");
	});

	it("if the output-last-message file exists after run, its contents become the stdout returned to caller", async () => {
		const b = new CodexBackend();
		const _outFile = join(dir, "threads", "T-1", "codex-last.txt");
		let argvSeen: string[] = [];
		const result = await b.run({
			threadId: "T-1",
			cwdInContainer: "/workspace/threads/T-1/worktree",
			prompt: "hi",
			dataDir: dir,
			timeoutMs: 5_000,
			sandboxExec: async (argv) => {
				argvSeen = argv;
				// Simulate Codex writing the reply text to the -o file path.
				const oIdx = argv.indexOf("-o");
				await writeFile(argv[oIdx + 1], "the real reply from codex");
				return {
					exitCode: 0,
					stdout: '{"session_id":"x"}\n{"type":"message"}\n',
					stderr: "",
					durationMs: 1,
					timedOut: false,
				};
			},
		});
		expect(result.stdout).toBe("the real reply from codex");
		expect(argvSeen).toContain("-o");
	});
});
