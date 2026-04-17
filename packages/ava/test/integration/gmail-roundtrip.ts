/**
 * Manual Gmail round-trip test.
 *
 * Requires a SECOND Gmail account with OAuth configured. Sends a test
 * email to claude@actualvoice.ai and waits up to 3 minutes for both the
 * ack and the final reply.
 *
 *   AVA_TEST_SENDER_CREDS=./data/test-sender-creds.json \
 *   AVA_TEST_SENDER_TOKEN=./data/test-sender-token.json \
 *   AVA_TARGET=claude@actualvoice.ai \
 *     npx tsx packages/ava/test/integration/gmail-roundtrip.ts
 */
import { GmailClient } from "../../src/gmail/client.js";

async function main(): Promise<void> {
	const sender = new GmailClient();
	await sender.init({
		credentialsPath: process.env.AVA_TEST_SENDER_CREDS!,
		tokenPath: process.env.AVA_TEST_SENDER_TOKEN!,
	});
	const subject = `ava-roundtrip ${Date.now()}`;
	const messageId = `<roundtrip-${Date.now()}@test>`;
	const sentId = await sender.send({
		threadId: "",
		to: process.env.AVA_TARGET!,
		subject,
		bodyText: "Respond with any message.",
		inReplyTo: messageId,
		references: [messageId],
		attachments: [],
	});
	console.log(`sent ${sentId}, subject=${subject}`);

	const deadline = Date.now() + 3 * 60_000;
	while (Date.now() < deadline) {
		const ids = await sender.listUnread(`subject:"Re: ${subject}"`);
		if (ids.length >= 2) {
			console.log(`ack + reply received (${ids.length} messages)`);
			process.exit(0);
		}
		await new Promise((r) => setTimeout(r, 15_000));
	}
	console.error("timeout: did not receive ack + reply within 3m");
	process.exit(1);
}

main();
