import type { CommandSpec } from "../types.js";
import { helpCommand } from "./help.js";
import { initSpec } from "./init.js";
import { migrateSpec } from "./migrate.js";
import { versionCommand } from "./version.js";

/** Every command, in the order `help` lists them. Later tasks add theirs here. */
export const commands: CommandSpec[] = [helpCommand, versionCommand, initSpec, migrateSpec];
