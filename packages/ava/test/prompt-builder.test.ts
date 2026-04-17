import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/prompt-builder.js";

describe("buildPrompt", () => {
	it("includes sender, subject, and body", () => {
		const p = buildPrompt({
			isFirstRun: false,
			newestMessage: {
				from: "brian@actualvoice.ai",
				subject: "typo fix",
				bodyText: "fix the typo on /signup",
			},
			worktreePath: "/workspace/threads/T-1/worktree",
			outgoingPath: "./outgoing",
			globalMemory: "",
			threadMemory: "",
		});
		expect(p).toContain("brian@actualvoice.ai");
		expect(p).toContain("typo fix");
		expect(p).toContain("fix the typo on /signup");
		expect(p).toContain("/workspace/threads/T-1/worktree");
		expect(p).toContain("./outgoing");
	});

	it("includes memory on first run only", () => {
		const first = buildPrompt({
			isFirstRun: true,
			newestMessage: { from: "u@v", subject: "s", bodyText: "b" },
			worktreePath: "/w",
			outgoingPath: "./outgoing",
			globalMemory: "GLOBAL_MEM",
			threadMemory: "THREAD_MEM",
		});
		expect(first).toContain("GLOBAL_MEM");
		expect(first).toContain("THREAD_MEM");

		const later = buildPrompt({
			isFirstRun: false,
			newestMessage: { from: "u@v", subject: "s", bodyText: "b" },
			worktreePath: "/w",
			outgoingPath: "./outgoing",
			globalMemory: "GLOBAL_MEM",
			threadMemory: "THREAD_MEM",
		});
		expect(later).not.toContain("GLOBAL_MEM");
		expect(later).not.toContain("THREAD_MEM");
	});

	it("instructs the agent that stdout IS the reply (no reply-file drafting)", () => {
		const p = buildPrompt({
			isFirstRun: false,
			newestMessage: { from: "u@v", subject: "s", bodyText: "b" },
			worktreePath: "/w",
			outgoingPath: "./outgoing",
			globalMemory: "",
			threadMemory: "",
		});
		expect(p).toMatch(/stdout.*email body/i);
		expect(p).toMatch(/do not write a copy of your reply/i);
		expect(p).toMatch(/only\*?\*? for binary or large artifacts/i);
	});

	it("strips the @ava:use directive from the body shown to the agent", () => {
		const p = buildPrompt({
			isFirstRun: false,
			newestMessage: { from: "u@v", subject: "s", bodyText: "please do X @ava:use=codex thanks" },
			worktreePath: "/w",
			outgoingPath: "./outgoing",
			globalMemory: "",
			threadMemory: "",
		});
		expect(p).not.toContain("@ava:use");
	});
});
