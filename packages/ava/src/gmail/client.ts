import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { type gmail_v1, google } from "googleapis";
import { log } from "../log.js";

export interface GmailAuthFiles {
	credentialsPath: string; // OAuth client secret JSON from Google Cloud
	tokenPath: string; // where refresh token is persisted
}

export class GmailClient {
	private gmail!: gmail_v1.Gmail;

	async init(files: GmailAuthFiles): Promise<void> {
		const creds = JSON.parse(await readFile(files.credentialsPath, "utf-8"));
		const { client_id, client_secret, redirect_uris } = creds.installed ?? creds.web;
		const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
		if (!existsSync(files.tokenPath)) {
			throw new Error(`Gmail token not found at ${files.tokenPath}. Run: npx @actualvoice/ava auth:gmail`);
		}
		const token = JSON.parse(await readFile(files.tokenPath, "utf-8"));
		oauth2.setCredentials(token);
		oauth2.on("tokens", async (refreshed) => {
			const merged = { ...token, ...refreshed };
			await writeFile(files.tokenPath, JSON.stringify(merged, null, 2));
			log.debug("gmail token refreshed");
		});
		this.gmail = google.gmail({ version: "v1", auth: oauth2 });
	}

	async listUnread(query: string): Promise<string[]> {
		const res = await this.gmail.users.messages.list({
			userId: "me",
			q: query,
			maxResults: 50,
		});
		return (res.data.messages ?? []).map((m) => m.id!).filter(Boolean);
	}

	async getRaw(messageId: string): Promise<{ raw: Buffer; threadId: string }> {
		const res = await this.gmail.users.messages.get({
			userId: "me",
			id: messageId,
			format: "raw",
		});
		const raw = Buffer.from(res.data.raw as string, "base64url");
		return { raw, threadId: res.data.threadId ?? "" };
	}

	async markRead(messageId: string): Promise<void> {
		await this.gmail.users.messages.modify({
			userId: "me",
			id: messageId,
			requestBody: { removeLabelIds: ["UNREAD"] },
		});
	}

	async send(opts: {
		threadId: string;
		to: string;
		subject: string;
		bodyText: string;
		inReplyTo: string;
		references: string[];
		attachments: Array<{ filename: string; path: string }>;
	}): Promise<string> {
		const mime = await buildMime(opts);
		const res = await this.gmail.users.messages.send({
			userId: "me",
			requestBody: {
				threadId: opts.threadId,
				raw: mime.toString("base64url"),
			},
		});
		return res.data.id ?? "";
	}
}

async function buildMime(opts: {
	to: string;
	subject: string;
	bodyText: string;
	inReplyTo: string;
	references: string[];
	attachments: Array<{ filename: string; path: string }>;
}): Promise<Buffer> {
	const boundary = `ava-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const headers = [
		`To: ${opts.to}`,
		`Subject: ${encodeHeader(opts.subject)}`,
		`In-Reply-To: ${opts.inReplyTo}`,
		`References: ${opts.references.join(" ")}`,
		`MIME-Version: 1.0`,
		`Content-Type: multipart/mixed; boundary="${boundary}"`,
	];
	const parts: string[] = [
		"",
		`--${boundary}`,
		`Content-Type: text/plain; charset=utf-8`,
		`Content-Transfer-Encoding: 8bit`,
		"",
		opts.bodyText,
	];
	for (const att of opts.attachments) {
		const data = (await readFile(att.path)).toString("base64");
		parts.push(
			`--${boundary}`,
			`Content-Type: application/octet-stream; name="${att.filename}"`,
			`Content-Disposition: attachment; filename="${att.filename}"`,
			`Content-Transfer-Encoding: base64`,
			"",
			data,
		);
	}
	parts.push(`--${boundary}--`, "");
	return Buffer.from(`${headers.join("\r\n")}\r\n${parts.join("\r\n")}`, "utf-8");
}

/**
 * RFC 2047 encoding for MIME headers that contain non-ASCII. Without this,
 * UTF-8 bytes in a header get interpreted as Latin-1 by some clients and
 * render as mojibake ("—" → "Ã¢Â€Â\"", etc.).
 */
function encodeHeader(raw: string): string {
	if (/^[\x20-\x7e]*$/.test(raw)) return raw; // pure ASCII — no encoding needed
	const b64 = Buffer.from(raw, "utf-8").toString("base64");
	return `=?UTF-8?B?${b64}?=`;
}
