import type { Sql } from "postgres";
import type { MoggingConfig } from "./schema/config.js";

export type Ctx = { sql: Sql; config: MoggingConfig; actor: string };
