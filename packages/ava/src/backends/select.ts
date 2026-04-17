import type { BackendName } from "../types.js";

const DIRECTIVE_RX = /@ava:use=([a-z-]+)/i;
const VALID: BackendName[] = ["claude-code", "codex", "pi"];

export function parseBackendDirective(body: string): BackendName | null {
	const m = body.match(DIRECTIVE_RX);
	if (!m) return null;
	const v = m[1].toLowerCase() as BackendName;
	return VALID.includes(v) ? v : null;
}

export interface BackendSelection {
	primary: BackendName;
	fallback: BackendName | null;
}

export function selectBackend(opts: {
	settingsDefault: BackendName;
	settingsFallback: BackendName | null;
	directive: BackendName | null;
}): BackendSelection {
	if (opts.directive) {
		return { primary: opts.directive, fallback: null };
	}
	return { primary: opts.settingsDefault, fallback: opts.settingsFallback };
}

export function shouldEmitPiTosWarning(cfg: { default: BackendName; fallback: BackendName | null }): boolean {
	return cfg.default === "pi" || cfg.fallback === "pi";
}
