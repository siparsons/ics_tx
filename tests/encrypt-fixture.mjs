import { webcrypto } from "node:crypto";
import { encryptCalendarPayload } from "../browser/src/crypto.js";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { payload, publicKey } = JSON.parse(input);
const envelope = await encryptCalendarPayload(payload, publicKey.jwk, publicKey.keyId, webcrypto);
process.stdout.write(JSON.stringify(envelope));
