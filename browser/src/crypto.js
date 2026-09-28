export function base64url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// The payload is serialized and encrypted entirely within the browser.
export async function encryptCalendarPayload(payload, publicJwk, keyId = "primary", cryptoApi = globalThis.crypto) {
  const rsa = await cryptoApi.subtle.importKey("jwk", publicJwk,
    { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const aes = await cryptoApi.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  let rawKey;
  try {
    const ciphertext = await cryptoApi.subtle.encrypt({
      name: "AES-GCM", iv, additionalData: new TextEncoder().encode("calendar-bridge-v1"), tagLength: 128
    }, aes, plaintext);
    rawKey = new Uint8Array(await cryptoApi.subtle.exportKey("raw", aes));
    const wrappedKey = await cryptoApi.subtle.encrypt({ name: "RSA-OAEP" }, rsa, rawKey);
    return { version: 1, keyId, wrappedKey: base64url(wrappedKey), iv: base64url(iv), ciphertext: base64url(ciphertext) };
  } finally {
    plaintext.fill(0);
    rawKey?.fill(0);
  }
}
