import { readFile, writeFile } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send"];

export async function gmailAuthSetup(opts: { credentialsPath: string; tokenPath: string }): Promise<void> {
	const creds = JSON.parse(await readFile(opts.credentialsPath, "utf-8"));
	const { client_id, client_secret, redirect_uris } = creds.installed ?? creds.web;
	const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
	const url = oauth2.generateAuthUrl({ access_type: "offline", scope: SCOPES, prompt: "consent" });
	console.log("\nOpen this URL in a browser, grant consent, then paste the resulting code:\n");
	console.log(url);
	const rl = createInterface({ input, output });
	try {
		const code = (await rl.question("\nCode: ")).trim();
		const { tokens } = await oauth2.getToken(code);
		await writeFile(opts.tokenPath, JSON.stringify(tokens, null, 2));
		console.log(`Token written to ${opts.tokenPath}`);
	} finally {
		rl.close();
	}
}
