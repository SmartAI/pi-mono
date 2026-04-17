import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

export async function parseRaw(
	raw: Buffer,
	opts: { threadId: string; attachmentsDir?: string },
): Promise<ParsedInboundMessage> {
	const parsed: ParsedMail = await simpleParser(raw);
	const authHeader = parsed.headers.get("authentication-results");
	const authStr = typeof authHeader === "string" ? authHeader : undefined;

	// If a target dir is supplied, write the real attachment bytes to disk and
	// capture path + size. Without this, the caller only sees zero-byte
	// placeholders (mailparser already parsed the bytes into .content but we'd
	// be discarding them).
	const attachmentMeta: Array<{ filename: string; path: string; bytes: number }> = [];
	if (opts.attachmentsDir && (parsed.attachments ?? []).length > 0) {
		await mkdir(opts.attachmentsDir, { recursive: true });
		for (const a of parsed.attachments ?? []) {
			const filename = a.filename ?? `unnamed-${a.contentId ?? attachmentMeta.length}`;
			const abs = join(opts.attachmentsDir, filename);
			const buf = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content ?? "");
			await writeFile(abs, buf);
			attachmentMeta.push({ filename, path: abs, bytes: buf.length });
		}
	} else {
		for (const a of parsed.attachments ?? []) {
			attachmentMeta.push({
				filename: a.filename ?? "unnamed",
				path: "",
				bytes: a.size ?? (Buffer.isBuffer(a.content) ? a.content.length : 0),
			});
		}
	}

	const lowerHeaders: Record<string, string> = {};
	for (const [k, v] of parsed.headers.entries()) {
		lowerHeaders[k.toLowerCase()] = typeof v === "string" ? v : JSON.stringify(v);
	}

	return {
		gmailMessageId: parsed.messageId ?? "",
		threadId: opts.threadId,
		from: firstAddress(parsed.from),
		to: addresses(parsed.to),
		cc: addresses(parsed.cc),
		subject: parsed.subject ?? "",
		bodyText: stripQuoted(parsed.text ?? ""),
		dkimResult: classifyAuth(authStr, "dkim"),
		spfResult: classifyAuth(authStr, "spf"),
		attachments: attachmentMeta,
		receivedAt: (parsed.date ?? new Date()).toISOString(),
		headers: lowerHeaders,
	};
}
