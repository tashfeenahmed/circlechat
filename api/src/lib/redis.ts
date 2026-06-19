import IORedis from "ioredis";
import { config } from "./config.js";

// Under test there is no redis. Two problems followed from creating the clients
// naively: (1) they eagerly opened sockets just because a module transitively
// imported this file, and (2) with no "error" listener, ioredis printed
// "[ioredis] Unhandled error event" to the console on every failed retry — and
// one of those console writes, landing during a vitest worker teardown, threw
// `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`
// and failed CI even though all tests passed.
//
// Fix: connect lazily under test (no sockets unless a test actually issues a
// command), and ALWAYS attach an error handler so a connection failure is
// handled rather than printed (and, in production, can't crash the process).
// Command failures still reject their own promises, so callers see real errors.
const isTest = !!process.env.VITEST || process.env.NODE_ENV === "test";

const baseOpts = {
  maxRetriesPerRequest: null, // required by bullmq
  enableReadyCheck: false,
  ...(isTest ? { lazyConnect: true } : {}),
};

function makeRedis(label: string): IORedis {
  const client = new IORedis(config.redisUrl, baseOpts);
  client.on("error", (err: Error) => {
    if (!isTest) console.warn(`[redis:${label}] ${err?.message ?? err}`);
  });
  return client;
}

export const redis = makeRedis("main");
export const pub = makeRedis("pub");
export const sub = makeRedis("sub");
