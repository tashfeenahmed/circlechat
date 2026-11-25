// Only fixed route and action names are sent to the company's telemetry services.
(() => {
  const host = location.hostname;
  if (!(host.endsWith('.circlechat.co') && host !== 'www.circlechat.co') || navigator.doNotTrack === '1' || navigator.globalPrivacyControl) return;
  if (window.__neuMonitoring) return;
  window.__neuMonitoring = true;

  const sections = new Set(["about", "guides", "tools", "pricing", "demo", "support", "privacy", "terms", "download", "signup", "login", "contact", "book", "blog", "docs", "features", "help", "models", "settings", "dashboard", "learn", "courses", "compare", "gallery"]);
  const session = crypto.randomUUID();
  let lastPath;
  let reports = 0;
  function page() {
    const section = location.pathname.split('/').filter(Boolean)[0];
    return !section ? '/' : sections.has(section) ? '/' + section : '/other';
  }
  function send(url, data, headers) {
    try {
      if (localStorage.getItem('umami.disabled') === '1' || localStorage.getItem('neu:visitor-optout') === '1') return;
    } catch { /* Privacy mode may disable storage. */ }
    void fetch(url, { method: 'POST', body: data, headers, keepalive: true,
      credentials: 'omit', referrerPolicy: 'no-referrer' }).catch(() => {});
  }
  function track(name, properties = {}) {
    send('https://analytics.neu.so/api/track', JSON.stringify({ type: 'track', payload: {
      name, properties: { __deviceId: session, __path: 'https://circlechat.co' + page(), platform: 'web', ...properties },
    } }), { 'Content-Type': 'application/json', 'openpanel-client-id': '088a928e-6a7a-4072-8e08-325e9fbe7661' });
  }
  function view() {
    if (lastPath !== location.pathname) track('screen_view');
    lastPath = location.pathname;
  }
  function report(err, line, column) {
    if (reports >= 5) return;
    reports++;
    const type = ['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'].includes(err?.name) ? err.name : 'Error';
    const id = crypto.randomUUID().replace(/-/g, '');
    const event = { event_id: id, timestamp: Date.now() / 1000, environment: 'production',
      platform: 'javascript', level: 'error', tags: { page: page() },
      exception: { values: [{ type, value: 'Browser exception', stacktrace: { frames: [{
        filename: 'web-client', lineno: line || undefined, colno: column || undefined, in_app: true,
      }] } }] } };
    send('https://errors.neu.so/api/31/envelope/?sentry_key=83d558e598f8453a8b4340da022610ce&sentry_version=7', [{ event_id: id }, { type: 'event' }, event].map(x => JSON.stringify(x)).join('\n'),
      { 'Content-Type': 'text/plain' });
  }
  window.addEventListener('error', e => { if (e.error || e.filename) report(e.error, e.lineno, e.colno); });
  window.addEventListener('unhandledrejection', e => report(e.reason));
  document.addEventListener('click', e => {
    const anchor = e.target.closest?.('a[href]');
    if (!anchor) return;
    const target = new URL(anchor.href, location.href);
    if (target.hostname === 'apps.apple.com' || target.hostname === 'play.google.com') {
      track('store_click', { store: target.hostname === 'apps.apple.com' ? 'ios' : 'android' });
    } else if (target.origin === location.origin) {
      const section = target.pathname.split('/').filter(Boolean)[0];
      if (['pricing', 'demo', 'download', 'signup', 'contact', 'book'].includes(section)) track(section + '_click');
    }
  }, true);
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      view();
      return result;
    };
  }
  window.addEventListener('popstate', view);
  view();
})();
