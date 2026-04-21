import { promises as fs, createReadStream, type Stats } from "node:fs";
import { resolve, dirname, normalize, sep } from "node:path";
import { config } from "./config.js";

const ROOT = resolve(config.storageDir);

await fs.mkdir(ROOT, { recursive: true });

function safeJoin(key: string): string {
  const abs = normalize(resolve(ROOT, key));
  if (!abs.startsWith(ROOT + sep) && abs !== ROOT) {
    throw new Error("invalid_key");
  }
  return abs;
}

export async function putObject(key: string, body: Buffer): Promise<void> {
  const abs = safeJoin(key);
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, body);
}

export async function statObject(key: string): Promise<Stats | null> {
  try {
    return await fs.stat(safeJoin(key));
  } catch {
    return null;
  }
}

export function streamObject(key: string): NodeJS.ReadableStream {
  return createReadStream(safeJoin(key));
}

export async function deleteObject(key: string): Promise<void> {
  try {
    await fs.unlink(safeJoin(key));
  } catch {
    // ignore — "delete" is idempotent
  }
}

export function publicUrl(key: string): string {
  // Absolute so agents (bearer-auth'd curl) can follow the URL directly.
  return `${config.publicBaseUrl.replace(/\/$/, "")}/files/${key}`;
}
