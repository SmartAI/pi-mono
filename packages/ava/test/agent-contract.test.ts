import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildEmailBody,
	detectDoneEmptyMismatch,
	parseAgentContract,
	resolveContractAttachments,
} from "../src/agent-contract.js";

describe("parseAgentContract", () => {
	it("accepts a well-formed done contract", () => {
		const r = parseAgentContract(
			JSON.stringify({
				status: "done",
				email_body: "ok",
				actions: [{ kind: "commit", sha: "abc1234" }],
			}),
		);
		expect(r.ok).toBe(true);
	});

	it("flags done + empty actions as a mismatch", () => {
		const r = parseAgentContract(JSON.stringify({ status: "done", email_body: "hi", actions: [] }));
		expect(r.ok).toBe(true);
		if (r.ok) expect(detectDoneEmptyMismatch(r.contract)).toBe(true);
	});

	it("appends a warning note to email body when done+empty", () => {
		const r = parseAgentContract(JSON.stringify({ status: "done", email_body: "Shipped.", actions: [] }));
		if (!r.ok) throw new Error("parse failed");
		expect(buildEmailBody(r.contract)).toMatch(/Ava note.*status="done".*zero concrete actions/);
	});

	it("parses optional attachments array", () => {
		const r = parseAgentContract(
			JSON.stringify({
				status: "done",
				email_body: "see attached",
				actions: [{ kind: "file_write", path: "/workspace/foo.md" }],
				attachments: [{ path: "/workspace/foo.md", filename: "foo.md" }],
			}),
		);
		if (!r.ok) throw new Error("parse failed");
		expect(r.contract.attachments).toEqual([{ path: "/workspace/foo.md", filename: "foo.md" }]);
	});

	it("rejects attachment without a path", () => {
		const r = parseAgentContract(
			JSON.stringify({
				status: "done",
				email_body: "x",
				actions: [],
				attachments: [{ filename: "orphan.txt" }],
			}),
		);
		expect(r.ok).toBe(false);
	});
});

describe("resolveContractAttachments", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ava-att-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("resolves a sandbox path to the host path via the containerDataDir prefix", async () => {
		const file = join(dir, "hello.md");
		writeFileSync(file, "hello");
		const r = await resolveContractAttachments([{ path: "/workspace/hello.md" }], {
			hostDataDir: dir,
			containerDataDir: "/workspace",
			perReplyCapBytes: 1024,
		});
		expect(r.resolved).toHaveLength(1);
		expect(r.resolved[0].hostPath).toBe(file);
		expect(r.resolved[0].filename).toBe("hello.md");
		expect(r.resolved[0].bytes).toBe(5);
		expect(r.errors).toEqual([]);
	});

	it("rejects paths outside the sandbox containerDataDir", async () => {
		const r = await resolveContractAttachments([{ path: "/etc/passwd" }], {
			hostDataDir: dir,
			containerDataDir: "/workspace",
			perReplyCapBytes: 1024,
		});
		expect(r.resolved).toHaveLength(0);
		expect(r.errors[0].reason).toMatch(/must be under \/workspace/);
	});

	it("rejects non-absolute paths", async () => {
		const r = await resolveContractAttachments([{ path: "outgoing/foo.md" }], {
			hostDataDir: dir,
			containerDataDir: "/workspace",
			perReplyCapBytes: 1024,
		});
		expect(r.errors[0].reason).toBe("path is not absolute");
	});

	it("reports missing files without throwing", async () => {
		const r = await resolveContractAttachments([{ path: "/workspace/nope.md" }], {
			hostDataDir: dir,
			containerDataDir: "/workspace",
			perReplyCapBytes: 1024,
		});
		expect(r.resolved).toHaveLength(0);
		expect(r.errors[0].reason).toMatch(/stat failed/);
	});

	it("moves files over the cap into overCap, not resolved", async () => {
		const small = join(dir, "small.md");
		const big = join(dir, "big.md");
		writeFileSync(small, "x".repeat(100));
		writeFileSync(big, "y".repeat(10_000));
		const r = await resolveContractAttachments([{ path: "/workspace/small.md" }, { path: "/workspace/big.md" }], {
			hostDataDir: dir,
			containerDataDir: "/workspace",
			perReplyCapBytes: 1_000,
		});
		expect(r.resolved.map((a) => a.filename)).toEqual(["small.md"]);
		expect(r.overCap.map((o) => o.filename)).toEqual(["big.md"]);
	});

	it("uses provided filename over the basename when given", async () => {
		const file = join(dir, "ugly-internal-name.md");
		writeFileSync(file, "hi");
		const r = await resolveContractAttachments(
			[{ path: "/workspace/ugly-internal-name.md", filename: "Pretty Name.md" }],
			{ hostDataDir: dir, containerDataDir: "/workspace", perReplyCapBytes: 1024 },
		);
		expect(r.resolved[0].filename).toBe("Pretty Name.md");
	});
});
