import type { CommandSpec } from "../types.js";
import { helpCommand } from "./help.js";
import { exportSpec } from "./export.js";
import { importSpec } from "./import.js";
import { initSpec } from "./init.js";
import { migrateSpec } from "./migrate.js";
import { statusSpec } from "./status.js";
import { trackSpec } from "./track.js";
import { versionCommand } from "./version.js";

/** Every command, in the order `help` lists them. Later tasks add theirs here. */
export const commands: CommandSpec[] = [
  helpCommand, versionCommand, initSpec, migrateSpec, importSpec, exportSpec, statusSpec, trackSpec,
];
