/**
 * Licence signing tool (not shipped in @mogging/core). Usage:
 *   MOGGING_LICENSE_PRIVATE_KEY="$(cat private.pem)" \
 *     tsx tools/licence/sign.ts --licensee "Acme GmbH" --id lic_0001 --expiry 2027-11-11 --plan solo
 * Prints the token on stdout. The private key is read from the environment only and is never printed.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { encodeKey } from "../../packages/core/src/licence/key.js";
import type { LicencePayload } from "../../packages/core/src/licence/key.js";

const FLAGS = { "--licensee": "licensee", "--id": "license_id", "--expiry": "expiry", "--plan": "plan" } as const;
type Field = (typeof FLAGS)[keyof typeof FLAGS];

/** Parses the flags, signs with `MOGGING_LICENSE_PRIVATE_KEY` from `env`, returns the token. */
export function signFromArgs(argv: string[], env: Record<string, string | undefined> = process.env): string {
  const values: Partial<Record<Field, string>> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    if (!Object.hasOwn(FLAGS, flag)) throw new Error(`Unknown argument "${flag}"`);
    const value = argv[i + 1];
    if (value === undefined || value === "") throw new Error(`${flag} needs a value`);
    values[FLAGS[flag as keyof typeof FLAGS]] = value;
  }
  for (const [flag, field] of Object.entries(FLAGS)) {
    if (values[field] === undefined) throw new Error(`Missing ${flag}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.expiry!)) throw new Error("--expiry must be YYYY-MM-DD");
  const pem = env.MOGGING_LICENSE_PRIVATE_KEY;
  if (!pem) throw new Error("MOGGING_LICENSE_PRIVATE_KEY is not set");
  const payload: LicencePayload = {
    licensee: values.licensee!, license_id: values.license_id!, expiry: values.expiry!, plan: values.plan!,
  };
  try {
    return encodeKey(payload, pem);
  } catch (e) {
    // Never surface key material: report only the error class/code.
    const code = (e as { code?: unknown }).code;
    throw new Error(`Signing failed${typeof code === "string" ? ` (${code})` : ""}: check the payload and the private key`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${signFromArgs(process.argv.slice(2))}\n`);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exitCode = 1;
  }
}
