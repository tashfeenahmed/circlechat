// Lighthouse stage: serves the built web app and audits the two public,
// non-auth-walled pages (/login, /signup). Captures the §16 paint/interaction
// metrics. The authed chat shell is intentionally out of scope here (would need
// a seeded login flow) — see README.
import { serveStatic } from "../lib/serve.mjs";
import { round } from "../lib/util.mjs";

const WEB_DIST = new URL("../../web/dist/", import.meta.url).pathname;

async function audit(url) {
  // Imported lazily so `bundle`/`backend`-only runs don't pay the cost.
  const lighthouse = (await import("lighthouse")).default;
  const chromeLauncher = await import("chrome-launcher");
  const chrome = await chromeLauncher.launch({
    chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  try {
    const res = await lighthouse(
      url,
      { port: chrome.port, output: "json", logLevel: "error", onlyCategories: ["performance"] },
      { extends: "lighthouse:default", settings: { formFactor: "desktop", screenEmulation: { disabled: true } } },
    );
    const a = res.lhr.audits;
    return {
      fcp: a["first-contentful-paint"]?.numericValue ?? null,
      lcp: a["largest-contentful-paint"]?.numericValue ?? null,
      tbt: a["total-blocking-time"]?.numericValue ?? null,
      tti: a["interactive"]?.numericValue ?? null,
      score: (res.lhr.categories.performance?.score ?? 0) * 100,
    };
  } finally {
    await chrome.kill();
  }
}

export async function runLighthouse() {
  const metrics = {};
  const notes = [];
  let server;
  try {
    server = await serveStatic(WEB_DIST, 4180);
  } catch (e) {
    return { metrics, notes: [`lighthouse: SKIPPED — could not serve web/dist (${e.message})`] };
  }
  try {
    const login = await audit(`${server.url}/login`);
    metrics.fcp_login_ms = round(login.fcp);
    metrics.lcp_login_ms = round(login.lcp);
    metrics.tbt_login_ms = round(login.tbt);
    metrics.tti_login_ms = round(login.tti);
    metrics.perf_score_login = round(login.score);

    const signup = await audit(`${server.url}/signup`);
    metrics.fcp_signup_ms = round(signup.fcp);
  } catch (e) {
    notes.push(`lighthouse: SKIPPED — ${e.message} (is Chrome installed?)`);
  } finally {
    await server.close();
  }
  return { metrics, notes };
}
