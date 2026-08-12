import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

const blockedAddresses = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

export interface SafeFetchResult {
  response: Response;
  finalUrl: URL;
}

/**
 * Parse an agent-supplied URL and reject syntax that can target a local
 * service. DNS/IP checks happen separately immediately before the request.
 */
export function parsePublicHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("unsafe_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsafe_url");
  if (url.username || url.password) throw new Error("unsafe_url");
  if ((url.protocol === "http:" && url.port && url.port !== "80") ||
      (url.protocol === "https:" && url.port && url.port !== "443")) {
    throw new Error("unsafe_url");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname ||
      hostname === "localhost" ||
      !hostname.includes(".") ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".home.arpa")) {
    throw new Error("unsafe_url");
  }
  if (isIP(hostname) && isBlockedAddress(hostname)) throw new Error("unsafe_url");
  return url;
}

/**
 * Fetch an untrusted URL without exposing private networks. Every redirect is
 * revalidated and the request is pinned to the vetted DNS result, preventing
 * DNS rebinding between validation and connection.
 */
export async function safePublicFetch(
  rawUrl: string,
  options: { signal?: AbortSignal; maxRedirects?: number } = {},
): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? 3;
  let url = parsePublicHttpUrl(rawUrl);

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await requestPinned(url, options.signal);
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: url };
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirect === maxRedirects) throw new Error("unsafe_redirect");
    url = parsePublicHttpUrl(new URL(location, url).toString());
  }
  throw new Error("unsafe_redirect");
}

async function requestPinned(url: URL, signal?: AbortSignal): Promise<Response> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const answers = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!answers.length || answers.some((answer) => isBlockedAddress(answer.address))) {
    throw new Error("unsafe_url");
  }
  const pinned = answers[0];
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;

  return await new Promise<Response>((resolve, reject) => {
    const req = request(url, {
      method: "GET",
      signal,
      lookup: ((_host: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void) => {
        callback(null, pinned.address, pinned.family);
      }) as never,
    }, (res) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      const status = res.statusCode ?? 502;
      const body = status === 204 || status === 304
        ? undefined
        : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
      resolve(new Response(body, { status, headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedAddresses.check(address, "ipv4");
  if (family === 6) return blockedAddresses.check(address, "ipv6");
  return true;
}
