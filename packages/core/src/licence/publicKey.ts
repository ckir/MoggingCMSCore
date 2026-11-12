/**
 * Ed25519 public keys accepted by `verifyKey` (spec 12.2, 12.3), as SPKI PEM strings.
 *
 * The production public key was embedded on 2026-11-12. Its private half is kept OFFLINE by the owner and
 * is never committed; it is used only by tools/licence/sign.ts (read from MOGGING_LICENSE_PRIVATE_KEY).
 *
 * To rotate: generate a new Ed25519 keypair offline
 *      openssl genpkey -algorithm ed25519 -out mogging-licence-private.pem
 *      openssl pkey -in mogging-licence-private.pem -pubout -out mogging-licence-public.pem
 * add the new public key PEM FIRST in this array, and keep old keys until every key they signed has expired.
 *
 * Each entry must be a real PEM with line breaks. Write it as a template literal; a string continued with a
 * trailing backslash collapses the line breaks into spaces, Node then cannot parse it, and `verifyKey` skips an
 * unusable entry silently, so every licence would read as invalid. After any change, sign a throwaway token with
 * tools/licence/sign.ts and check that `verifyKey` accepts it.
 *
 * If this array is ever empty, no key verifies, so every install runs in evaluation mode and is refused after
 * the 30-day window (fail closed).
 */
export const PUBLIC_KEYS: readonly string[] = [
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAZ5Q3xHidRAClHO6D9i2cSwGFyODO/D7IHD8ZJj3i08I=
-----END PUBLIC KEY-----
`,
];
