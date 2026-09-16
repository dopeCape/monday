import { defineConfig } from "drizzle-kit";

// Migrations are generated here and checked in under drizzle/. They run only
// from the server at startup (src/db/migrate.ts), never from the client.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
});
