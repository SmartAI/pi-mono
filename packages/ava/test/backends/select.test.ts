import { describe, expect, it } from "vitest";
import { parseBackendDirective, selectBackend, shouldEmitPiTosWarning } from "../../src/backends/select.js";

describe("parseBackendDirective", () => {
	it("finds @ava:use=codex", () => {
		expect(parseBackendDirective("please do X @ava:use=codex")).toBe("codex");
	});
	it("is case-insensitive", () => {
		expect(parseBackendDirective("@AVA:USE=Claude-Code go")).toBe("claude-code");
	});
	it("returns null if no directive", () => {
		expect(parseBackendDirective("just a normal email")).toBeNull();
	});
	it("returns null for invalid backend name", () => {
		expect(parseBackendDirective("@ava:use=gemini")).toBeNull();
	});
});

describe("selectBackend", () => {
	it("honors directive when present", () => {
		const r = selectBackend({ settingsDefault: "claude-code", settingsFallback: "codex", directive: "pi" });
		expect(r.primary).toBe("pi");
		expect(r.fallback).toBeNull();
	});
	it("defaults to settings primary+fallback when no directive", () => {
		const r = selectBackend({ settingsDefault: "claude-code", settingsFallback: "codex", directive: null });
		expect(r.primary).toBe("claude-code");
		expect(r.fallback).toBe("codex");
	});
	it("omits fallback if not configured", () => {
		const r = selectBackend({ settingsDefault: "codex", settingsFallback: null, directive: null });
		expect(r.fallback).toBeNull();
	});
});

describe("shouldEmitPiTosWarning", () => {
	it("warns when pi is default", () => {
		expect(shouldEmitPiTosWarning({ default: "pi", fallback: null })).toBe(true);
	});
	it("warns when pi is fallback", () => {
		expect(shouldEmitPiTosWarning({ default: "claude-code", fallback: "pi" })).toBe(true);
	});
	it("does not warn when pi is neither", () => {
		expect(shouldEmitPiTosWarning({ default: "claude-code", fallback: "codex" })).toBe(false);
	});
});
