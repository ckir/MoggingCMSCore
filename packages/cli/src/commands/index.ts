import type { CommandSpec } from "../types.js";
import { compileSpec } from "./compile.js";
import { helpCommand } from "./help.js";
import { exportSpec } from "./export.js";
import { importSpec } from "./import.js";
import { initSpec } from "./init.js";
import { jobsSpec } from "./jobs.js";
import { migrateSpec } from "./migrate.js";
import { provenanceSpec } from "./provenance.js";
import { publishSpec } from "./publish.js";
import { querySpec } from "./query.js";
import { releaseSpec } from "./release.js";
import { statusSpec } from "./status.js";
import { trackSpec } from "./track.js";
import { unpublishSpec } from "./unpublish.js";
import { versionCommand } from "./version.js";
import { workerSpec } from "./worker.js";

/** Every command, in the order `help` lists them. Later tasks add theirs here. */
export const commands: CommandSpec[] = [
  helpCommand, versionCommand, initSpec, migrateSpec, importSpec, exportSpec, statusSpec, trackSpec,
  compileSpec, workerSpec, jobsSpec, provenanceSpec,
  publishSpec, unpublishSpec, releaseSpec, querySpec,
];
