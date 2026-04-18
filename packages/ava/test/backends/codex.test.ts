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

	it("first run: extracts thread id from JSONL stdout and persists it to pointer", async () => {
		const b = new CodexBackend();
		const sessionFile = join(dir, "threads", "T-1", "codex-session-id");
		const fakeJsonlStdout =
			'{"type":"thread.started","thread_id":"abcd1234-5678-90ef-1234-567890abcdef"}\n{"type":"message","content":"hi"}\n';
		await b.run({
			threadId: "T-1",
			cwdInContainer: "/workspace/threads/T-1/worktree",
			containerDataDir: dir,
			systemPrompt: "",
			userPrompt: "hi",
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

	it("first-run argv is `codex exec` with skip-perms + --json + --output-schema + -o, prompt last; no -m (inherits from config.toml)", async () => {
		const b = new CodexBackend();
		let argvSeen: string[] = [];
		await b.run({
			threadId: "T-1",
			cwdInContainer: "/workspace/threads/T-1/worktree",
			containerDataDir: dir,
			systemPrompt: "",
			userPrompt: "hi",
			dataDir: dir,
			timeoutMs: 5_000,
			sandboxExec: async (argv) => {
				argvSeen = argv;
				return { exitCode: 0, stdout: '{"thread_id":"x-y"}\n', stderr: "", durationMs: 1, timedOut: false };
			},
		});
		expect(argvSeen.slice(0, 2)).toEqual(["codex", "exec"]);
		expect(argvSeen).toContain("--json");
		expect(argvSeen).toContain("--dangerously-bypass-approvals-and-sandbox");
		expect(argvSeen).toContain("--output-schema");
		expect(argvSeen).toContain("-o");
		// model comes from the user's codex config — we do NOT pass -m.
		expect(argvSeen).not.toContain("-m");
		// working dir goes via sandboxExec, not as a CLI flag.
		expect(argvSeen).not.toContain("-C");
		expect(argvSeen).not.toContain("--cd");
		expect(argvSeen[argvSeen.length - 1]).toBe("hi");
	});

	it("resume run: options stay on `exec`, resume subcommand takes id + prompt as positionals", async () => {
		const b = new CodexBackend();
		const sessionFile = join(dir, "threads", "T-1", "codex-session-id");
		await writeFile(sessionFile, "prev-uuid");
		let argvSeen: string[] = [];
		await b.run({
			threadId: "T-1",
			cwdInContainer: "/workspace/threads/T-1/worktree",
			containerDataDir: dir,
			systemPrompt: "",
			userPrompt: "second",
			dataDir: dir,
			timeoutMs: 5_000,
			sandboxExec: async (argv) => {
				argvSeen = argv;
				return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
			},
		});
		// Options MUST come before `resume` — clap doesn't inherit our flags
		// onto the resume subcommand, so putting them after would silently
		// misapply. Resume + id + prompt are the last three tokens.
		const resumeIdx = argvSeen.indexOf("resume");
		expect(resumeIdx).toBeGreaterThan(0);
		expect(argvSeen.slice(resumeIdx)).toEqual(["resume", "prev-uuid", "second"]);
		// Options should live in argv[2..resumeIdx)
		expect(argvSeen.slice(0, resumeIdx)).toContain("--json");
		expect(argvSeen.slice(0, resumeIdx)).toContain("--output-schema");
		expect(argvSeen.slice(0, resumeIdx)).toContain("-o");
	});

	it("writes the JSON contract schema to dataDir on every run (idempotent, kept in lockstep with the TS contract)", async () => {
		const { readFile: rf } = await import("node:fs/promises");
		const b = new CodexBackend();
		await b.run({
			threadId: "T-1",
			cwdInContainer: "/workspace/threads/T-1/worktree",
			containerDataDir: dir,
			systemPrompt: "",
			userPrompt: "hi",
			dataDir: dir,
			timeoutMs: 5_000,
			sandboxExec: async () => ({
				exitCode: 0,
				stdout: '{"thread_id":"x"}',
				stderr: "",
				durationMs: 1,
				timedOut: false,
			}),
		});
		const schema = JSON.parse(await rf(join(dir, "codex-contract-schema.json"), "utf-8"));
		expect(schema.title).toBe("Ava Agent Contract");
		expect(schema.required).toEqual(["status", "email_body", "actions"]);
		expect(schema.properties.status.enum).toEqual(["done", "partial", "blocked"]);
	});

	it("forwards the worktree path to sandboxExec as workdir", async () => {
		const b = new CodexBackend();
		let optsSeen: { workdir?: string } = {};
		await b.run({
			threadId: "T-1",
			cwdInContainer: "/workspace/threads/T-1/worktree",
			containerDataDir: dir,
			systemPrompt: "",
			userPrompt: "hi",
			dataDir: dir,
			timeoutMs: 5_000,
			sandboxExec: async (_argv, opts) => {
				optsSeen = opts;
				return { exitCode: 0, stdout: '{"thread_id":"x"}\n', stderr: "", durationMs: 1, timedOut: false };
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
			containerDataDir: dir,
			systemPrompt: "",
			userPrompt: "hi",
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
