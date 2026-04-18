import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/prompt-builder.js";

const BASE = {
	worktreePath: "/workspace/threads/T-1/worktree",
	outgoingPath: "./outgoing",
	persona: "",
	globalMemory: "",
	threadMemory: "",
	skills: [],
};

describe("buildPrompt", () => {
	it("puts sender info + subject + body in the user prompt only (not system)", () => {
		const { systemPrompt, userPrompt } = buildPrompt({
			...BASE,
			newestMessage: {
				from: "brian@actualvoice.ai",
				subject: "typo fix",
				bodyText: "fix the typo on /signup",
				attachments: [],
			},
		});
		expect(userPrompt).toContain("brian@actualvoice.ai");
		expect(userPrompt).toContain("typo fix");
		expect(userPrompt).toContain("fix the typo on /signup");
		expect(systemPrompt).not.toContain("brian@actualvoice.ai");
		expect(systemPrompt).not.toContain("fix the typo on /signup");
	});

	it("puts worktree path in the system prompt and requires attachments declared via contract", () => {
		const { systemPrompt } = buildPrompt({
			...BASE,
			newestMessage: { from: "u@v", subject: "s", bodyText: "b", attachments: [] },
		});
		expect(systemPrompt).toContain("/workspace/threads/T-1/worktree");
		// New behavior: attachments are declared in the JSON contract, not
		// by dropping into a magic directory.
		expect(systemPrompt).toMatch(/attachments.*array.*response JSON/i);
		expect(systemPrompt).toMatch(/contract is authoritative/i);
	});

	it("injects memory every turn when non-empty (no isFirstRun gate)", () => {
		const { systemPrompt } = buildPrompt({
			...BASE,
			newestMessage: { from: "u@v", subject: "s", bodyText: "b", attachments: [] },
			globalMemory: "GLOBAL_MEM",
			threadMemory: "THREAD_MEM",
		});
		expect(systemPrompt).toContain("GLOBAL_MEM");
		expect(systemPrompt).toContain("THREAD_MEM");
	});

	it("omits memory sections when memory strings are empty", () => {
		const { systemPrompt } = buildPrompt({
			...BASE,
			newestMessage: { from: "u@v", subject: "s", bodyText: "b", attachments: [] },
		});
		expect(systemPrompt).not.toContain("Ava memory (global)");
		expect(systemPrompt).not.toContain("Ava memory (this thread)");
	});

	it("enumerates skills in the system prompt with name + description", () => {
		const { systemPrompt } = buildPrompt({
			...BASE,
			newestMessage: { from: "u@v", subject: "s", bodyText: "b", attachments: [] },
			skills: [
				{ name: "health-check", description: "Probe production services" },
				{ name: "meeting-notes", description: "Extract action items" },
			],
		});
		expect(systemPrompt).toContain("**health-check**: Probe production services");
		expect(systemPrompt).toContain("**meeting-notes**: Extract action items");
		expect(systemPrompt).toContain("2 available");
	});

	it("requires the JSON response contract in the system prompt", () => {
		const { systemPrompt } = buildPrompt({
			...BASE,
			newestMessage: { from: "u@v", subject: "s", bodyText: "b", attachments: [] },
		});
		expect(systemPrompt).toMatch(/Response format/i);
		expect(systemPrompt).toMatch(/"status":\s*"done" \| "partial" \| "blocked"/);
		expect(systemPrompt).toMatch(/"email_body":/);
		expect(systemPrompt).toMatch(/"actions":/);
	});

	it("lists attachments in the user prompt with their sandbox container paths", () => {
		const { userPrompt, systemPrompt } = buildPrompt({
			...BASE,
			newestMessage: {
				from: "brian@actualvoice.ai",
				subject: "spec attached",
				bodyText: "see attached",
				attachments: [
					{ filename: "spec.md", containerPath: "/workspace/threads/T-1/attachments/m1/spec.md", bytes: 4753 },
				],
			},
		});
		expect(userPrompt).toContain("Attachments (1)");
		expect(userPrompt).toContain("spec.md");
		expect(userPrompt).toContain("/workspace/threads/T-1/attachments/m1/spec.md");
		// Attachments go in user prompt, not system
		expect(systemPrompt).not.toContain("/workspace/threads/T-1/attachments");
	});

	it("injects persona into the system prompt when SOUL.md is non-empty", () => {
		const { systemPrompt } = buildPrompt({
			...BASE,
			newestMessage: { from: "u@v", subject: "s", bodyText: "b", attachments: [] },
			persona: "You are terse. You never apologize. You prefer facts to hedges.",
		});
		expect(systemPrompt).toContain("Who you are (voice, tone, identity)");
		expect(systemPrompt).toContain("You are terse.");
	});

	it("omits the persona section when SOUL.md is empty", () => {
		const { systemPrompt } = buildPrompt({
			...BASE,
			newestMessage: { from: "u@v", subject: "s", bodyText: "b", attachments: [] },
		});
		expect(systemPrompt).not.toContain("Who you are");
	});

	it("strips the @ava:use directive from the body shown to the agent", () => {
		const { userPrompt } = buildPrompt({
			...BASE,
			newestMessage: {
				from: "u@v",
				subject: "s",
				bodyText: "please do X @ava:use=codex thanks",
				attachments: [],
			},
		});
		expect(userPrompt).not.toContain("@ava:use");
	});
});
