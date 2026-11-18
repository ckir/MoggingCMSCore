/** Package-relative files (no leading `./`) that a packed manifest tells a consumer to load. */
export function entryFiles(manifest: Record<string, unknown>): string[];

/** Checks one tarball; returns one message per violated rule, empty when it is publishable. */
export function checkTarball(input: {
  listing: string[];
  manifest: Record<string, any>;
  source: Record<string, any>;
  siblings: Map<string, string>;
  release: boolean;
}): string[];
