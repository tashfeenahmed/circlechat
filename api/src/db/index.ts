import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import { config } from "../lib/config.js";

export const sql = postgres(config.databaseUrl, {
  max: 20,
  idle_timeout: 20,
  prepare: true,
});

export const db = drizzle(sql, { schema });
export { schema };
