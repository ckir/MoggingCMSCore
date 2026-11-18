// Fails when any commit after the freeze touches migration 0001 (v0.1 ship step 3, docs/dev-setup.md). It is the
// history-based twin of the content pin in packages/core/test/migrate.test.ts: editing 0001 AND updating that pin in
// one commit still fails here. A schema change is a new migration (0002_*.sql), never an edit of 0001.
// Run it as `pnpm check:frozen`; CI runs it with full history (actions/checkout fetch-depth: 0).
import { execFileSync } from "node:child_process";

/** The last commit before the freeze: the commit whose 0001 content is the frozen content. */
const FREEZE_BASE = "f27ac6c5c458abe790258c8002ec06efa7df134d";
const FILE = "packages/core/migrations/0001_engine.sql";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const ok = (...args) => {
  try {
    execFileSync("git", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

if (!ok("cat-file", "-e", `${FREEZE_BASE}^{commit}`)) {
  console.error(`check:frozen: commit ${FREEZE_BASE} is not in this clone. The history is incomplete (a shallow clone?): fetch the full history (CI: actions/checkout with fetch-depth: 0).`);
  process.exit(2);
}
if (!ok("merge-base", "--is-ancestor", FREEZE_BASE, "HEAD")) {
  console.error(`check:frozen: HEAD does not descend from the freeze base ${FREEZE_BASE}, so the freeze cannot be checked.`);
  process.exit(2);
}
const touched = git("log", "--format=%h %s", `${FREEZE_BASE}..HEAD`, "--", FILE);
if (touched !== "") {
  console.error(`check:frozen: migration 0001 is frozen (v0.1 ship step 3) but these commits after ${FREEZE_BASE.slice(0, 7)} change it:\n${touched}\nRevert the edit and add the schema change as a new migration (0002_*.sql). Do not move the freeze base or the hash pin in packages/core/test/migrate.test.ts to make this pass.`);
  process.exit(1);
}
console.log(`check:frozen: OK, no commit after ${FREEZE_BASE.slice(0, 7)} changes ${FILE}`);
