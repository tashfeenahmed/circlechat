const required = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
};

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required("DATABASE_URL", "postgres://postgres:circlechat@localhost:5432/circlechat"),
  redisUrl: required("REDIS_URL", "redis://localhost:6379"),
  sessionSecret: required("SESSION_SECRET", "dev-secret-change-me-at-least-32-chars-long"),
  publicBaseUrl: required("PUBLIC_BASE_URL", "http://localhost:5173"),
  apiInternalUrl: process.env.API_INTERNAL_URL ?? `http://localhost:${Number(process.env.PORT ?? 3000)}`,
  storageDir: process.env.STORAGE_DIR ?? "./storage",
  smtpUrl: process.env.SMTP_URL ?? "",
} as const;
