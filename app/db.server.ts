import { PrismaClient } from "@prisma/client";

declare global {
  var prisma: PrismaClient;
}

const databaseUrl = process.env.DATABASE_URL
  ? new URL(process.env.DATABASE_URL)
  : undefined;

// For Neon pooler: pgbouncer=true is required to disable prepared statements
// which are incompatible with PgBouncer's transaction pooling mode
if (databaseUrl) {
  if (
    databaseUrl.hostname.includes("pooler") &&
    !databaseUrl.searchParams.has("pgbouncer")
  ) {
    databaseUrl.searchParams.set("pgbouncer", "true");
  }
  if (!databaseUrl.searchParams.has("connect_timeout")) {
    databaseUrl.searchParams.set("connect_timeout", "15");
  }
  if (!databaseUrl.searchParams.has("pool_timeout")) {
    databaseUrl.searchParams.set("pool_timeout", "15");
  }
  if (!databaseUrl.searchParams.has("connection_limit")) {
    databaseUrl.searchParams.set("connection_limit", "3");
  }
}

const prisma: PrismaClient =
  globalThis.prisma ??
  new PrismaClient({
    datasourceUrl: databaseUrl?.toString() ?? process.env.DATABASE_URL,
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.prisma = prisma;
}

export default prisma;
