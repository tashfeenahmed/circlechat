// Always fetch/open the file-serve route on the SAME origin the app is served
// from, regardless of the absolute host the API stamped into the descriptor
// (PUBLIC_BASE_URL is for agents, which curl with a bearer token). Keeping it
// same-origin means the browser sends the `cc_session` cookie (the cookie is
// Secure + SameSite, so a cross-origin request drops it → 401 → the browser
// gives up and offers a local Save dialog instead of showing the file).
export function fileUrl(url: string | undefined | null): string {
  if (!url) return "";
  try {
    const u = new URL(url, window.location.origin);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}
