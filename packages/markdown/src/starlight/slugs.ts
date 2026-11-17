import { slug as githubSlug } from "github-slugger";
import { ValidationError } from "@mogging/core";
import { isSafeSlug } from "../slug.js";

/**
 * Derives a Mogging slug from a docs-relative file path, the way Starlight derives a page id (spec 5.2): each
 * `/`-separated segment is NFC-normalized and slugified with `github-slugger`, and the last segment loses its
 * extension first. A trailing `index` is kept (`guides/index.md` is `guides/index`).
 *
 * @param relPath POSIX path of the English file relative to the docs folder, for example `guides/Hello World.md`.
 * @returns the lowercase, `/`-joined slug, for example `guides/hello-world`.
 * @throws {ValidationError} when a segment slugifies to nothing (`!!.md`) or the result is not a safe slug.
 */
export function deriveSlug(relPath: string): string {
  const parts = relPath.split("/");
  const last = parts.length - 1;
  parts[last] = parts[last]!.replace(/\.[^./]*$/, "");
  const segments = parts.map((part) => {
    const s = githubSlug(part.normalize("NFC"));
    if (s === "") throw new ValidationError(`empty slug segment: "${part}" of "${relPath}" has no slug characters`);
    return s;
  });
  const out = segments.join("/");
  if (!isSafeSlug(out)) throw new ValidationError(`unsafe slug "${out}" derived from "${relPath}"`);
  return out;
}
