/**
 * Ed25519 public keys accepted by `verifyKey` (spec 12.2, 12.3), as SPKI PEM strings.
 *
 * OWNER ACTION REQUIRED: the production keypair has not been generated yet.
 *   1. Generate an Ed25519 keypair offline:
 *        openssl genpkey -algorithm ed25519 -out mogging-licence-private.pem
 *        openssl pkey -in mogging-licence-private.pem -pubout -out mogging-licence-public.pem
 *   2. Keep the private key OFFLINE (it lives only in the signing function, see tools/licence/sign.ts);
 *      it is never committed.
 *   3. Paste the public key PEM ("-----BEGIN PUBLIC KEY-----" ...) into this array, the CURRENT key FIRST.
 *      To rotate, add the new key first and keep old keys until every key they signed has expired.
 *
 * While this array is empty no key verifies, so every install runs in evaluation mode and is refused
 * after the 30-day window (fail closed).
 */
export const PUBLIC_KEYS: readonly string[] = [];
