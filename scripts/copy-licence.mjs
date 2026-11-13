// Run as each package's `prepack` (cwd is the package directory): copies the root LICENSE.md into the package so the
// tarball carries the licence text the manifest points at. The copies are git-ignored (`packages/*/LICENSE.md`).
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

copyFileSync(fileURLToPath(new URL("../LICENSE.md", import.meta.url)), join(process.cwd(), "LICENSE.md"));
