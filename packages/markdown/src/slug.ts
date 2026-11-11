/** True when `slug` is a non-empty `/`-separated path of real segments with no backslash and no NUL. */
export function isSafeSlug(slug: string): boolean {
  if (slug === "" || slug.includes("\\") || slug.includes("\0")) return false;
  return slug.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}
