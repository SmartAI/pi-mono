import { type AddressObject, type ParsedMail, simpleParser } from "mailparser";
import type { ParsedInboundMessage } from "../types.js";

const QUOTE_LINE = /^(?:On\b.*wrote:\s*$|[>].*)/i;

function stripQuoted(body: string): string {
	const lines = body.split(/\r?\n/);
	const cutoff = lines.findIndex((line) => QUOTE_LINE.test(line.trim()));
	if (cutoff === -1) return body.trim();
	return lines.slice(0, cutoff).join("\n").trim();
}

function classifyAuth(header: string | undefined, tag: "dkim" | "spf"): "pass" | "fail" | "none" {
	if (!header) return "none";
	const rx = new RegExp(`\\b${tag}=([a-z]+)`, "i");
	const m = header.match(rx);
	if (!m) return "none";
	const v = m[1].toLowerCase();
	if (v === "pass") return "pass";
	if (v === "fail" || v === "softfail" || v === "temperror" || v === "permerror") return "fail";
	return "none";
}

function firstAddress(a: AddressObject | AddressObject[] | undefined): string {
	if (!a) return "";
	const one = Array.isArray(a) ? a[0] : a;
	return (one?.value?.[0]?.address ?? "").toLowerCase();
}

function addresses(a: AddressObject | AddressObject[] | undefined): string[] {
	if (!a) return [];
	const arr = Array.isArray(a) ? a : [a];
	return arr.flatMap((o) => o.value.map((v) => (v.address ?? "").toLowerCase()).filter(Boolean));
}

export async function parseRaw(raw: Buffer, opts: { threadId: string }): Promise<ParsedInboundMessage> {
	const parsed: ParsedMail = await simpleParser(raw);
	const authHeader = parsed.headers.get("authentication-results");
	const authStr = typeof authHeader === "string" ? authHeader : undefined;

	const lowerHeaders: Record<string, string> = {};
	for (const [k, v] of parsed.headers.entries()) {
		lowerHeaders[k.toLowerCase()] = typeof v === "string" ? v : JSON.stringify(v);
	}

	return {
		gmailMessageId: parsed.messageId ?? "",
		threadId: opts.threadId,
		from: firstAddress(parsed.from),
		to: addresses(parsed.to),
		subject: parsed.subject ?? "",
		bodyText: stripQuoted(parsed.text ?? ""),
		dkimResult: classifyAuth(authStr, "dkim"),
		spfResult: classifyAuth(authStr, "spf"),
		attachments: (parsed.attachments ?? []).map((a) => ({
			filename: a.filename ?? "unnamed",
			path: "",
			bytes: a.size ?? 0,
		})),
		receivedAt: (parsed.date ?? new Date()).toISOString(),
		headers: lowerHeaders,
	};
}
