// SPDX-License-Identifier: AGPL-3.0-only
// The app catalog: popular APIs that connect with a token, ready to use.
// Each one is an HTTP connection with its address, how the token is sent, a short
// usage note for agents, and a "who am I" call so Test can say whose account it is.
// Tokens go into the vault; agents only ever call through the gateway.

export interface AppField {
  key: string;
  label: string;
  placeholder: string;
  hint?: string;
  /** what the value may look like (also stops anyone pointing the app at another host) */
  pattern: RegExp;
}

export interface AppPreset {
  id: string;
  name: string;
  category: "Code" | "Chat" | "Projects and docs" | "Sales and support" | "Payments and shops" | "Email and texts";
  blurb: string;
  /** may contain {field} placeholders */
  baseUrl: string;
  fields?: AppField[];
  auth: { kind: "header"; header: string; scheme: string } | { kind: "basic"; user: string };
  headers?: Record<string, string>;
  bodyFormat?: "json" | "form";
  secretLabel: string;
  secretPlaceholder: string;
  /** where to get the token, in plain steps */
  howTo: string;
  howToUrl: string;
  /** for agents: what the API is and the calls that matter */
  hint: string;
  check: { method: "GET" | "POST"; path: string; body?: unknown; who: (j: any) => string | undefined; ok?: (status: number, j: any) => boolean };
  /** fill fields from the secret itself (Mailchimp keys end with their data centre) */
  derive?: (secret: string) => Record<string, string>;
}

const SUB = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const EMAIL = /^[^@\s:/]+@[^@\s:/]+\.[^@\s:/]+$/;
const bearer = { kind: "header" as const, header: "Authorization", scheme: "Bearer " };

export const APP_CATALOG: AppPreset[] = [
  {
    id: "gitlab",
    name: "GitLab",
    category: "Code",
    blurb: "Issues, merge requests and pipelines",
    baseUrl: "https://gitlab.com/api/v4",
    auth: bearer,
    secretLabel: "Personal access token",
    secretPlaceholder: "glpat-…",
    howTo: "In GitLab, open Preferences, then Access tokens. Add a token with the api scope and copy it.",
    howToUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
    hint: "GitLab REST API v4. Projects use URL-encoded paths, e.g. /projects/group%2Frepo/issues. Common: GET /projects?membership=true, GET /projects/:id/issues, POST /projects/:id/issues {title, description}, GET /projects/:id/merge_requests.",
    check: { method: "GET", path: "/user", who: (j) => j?.username },
  },
  {
    id: "vercel",
    name: "Vercel",
    category: "Code",
    blurb: "Deployments, projects and domains",
    baseUrl: "https://api.vercel.com",
    auth: bearer,
    secretLabel: "Access token",
    secretPlaceholder: "vercel token",
    howTo: "In Vercel, open Account settings, then Tokens. Create a token and copy it.",
    howToUrl: "https://vercel.com/account/settings/tokens",
    hint: "Vercel REST API. Common: GET /v9/projects, GET /v6/deployments?projectId=ID&limit=10, GET /v13/deployments/ID, GET /v4/domains.",
    check: { method: "GET", path: "/v2/user", who: (j) => j?.user?.username },
  },
  {
    id: "sentry",
    name: "Sentry",
    category: "Code",
    blurb: "Errors and issues from your apps",
    baseUrl: "https://sentry.io/api/0",
    auth: bearer,
    secretLabel: "Auth token",
    secretPlaceholder: "sntryu_…",
    howTo: "In Sentry, open User settings, then Personal tokens. Create a token with read access to projects and issues.",
    howToUrl: "https://sentry.io/settings/account/api/auth-tokens/",
    hint: "Sentry API. Common: GET /organizations/, GET /organizations/ORG/projects/, GET /projects/ORG/PROJECT/issues/?query=is:unresolved, GET /issues/ID/events/latest/.",
    check: { method: "GET", path: "/organizations/", who: (j) => (Array.isArray(j) && j[0]?.slug ? j.map((o: any) => o.slug).join(", ") : undefined) },
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    category: "Code",
    blurb: "DNS, zones and Workers",
    baseUrl: "https://api.cloudflare.com/client/v4",
    auth: bearer,
    secretLabel: "API token",
    secretPlaceholder: "Cloudflare API token",
    howTo: "In Cloudflare, open My profile, then API tokens. Create a token with only the permissions you need.",
    howToUrl: "https://dash.cloudflare.com/profile/api-tokens",
    hint: "Cloudflare API v4. Common: GET /zones, GET /zones/ZONE_ID/dns_records, POST /zones/ZONE_ID/dns_records {type, name, content, ttl}.",
    check: { method: "GET", path: "/user/tokens/verify", who: (j) => (j?.result?.status ? `token ${j.result.status}` : undefined), ok: (s, j) => s < 300 && j?.success === true },
  },
  {
    id: "slack",
    name: "Slack",
    category: "Chat",
    blurb: "Read channels and post messages",
    baseUrl: "https://slack.com/api",
    auth: bearer,
    secretLabel: "Bot token",
    secretPlaceholder: "xoxb-…",
    howTo: "Create a Slack app, add bot scopes such as channels:read, channels:history and chat:write, install it to your workspace and copy the Bot User OAuth Token. Invite the bot to the channels it should use.",
    howToUrl: "https://api.slack.com/apps",
    hint: "Slack Web API. Every reply has ok true or false. Common: GET /conversations.list?types=public_channel, GET /conversations.history?channel=C123&limit=20, POST /chat.postMessage {channel, text}, GET /users.info?user=U123.",
    check: { method: "POST", path: "/auth.test", who: (j) => (j?.user ? `${j.user} in ${j.team}` : undefined), ok: (s, j) => s < 300 && j?.ok === true },
  },
  {
    id: "discord",
    name: "Discord",
    category: "Chat",
    blurb: "Post to channels as a bot",
    baseUrl: "https://discord.com/api/v10",
    auth: { kind: "header", header: "Authorization", scheme: "Bot " },
    secretLabel: "Bot token",
    secretPlaceholder: "Bot token",
    howTo: "In the Discord developer portal, create an application, open Bot, reset and copy the token, then invite the bot to your server.",
    howToUrl: "https://discord.com/developers/applications",
    hint: "Discord API v10. Common: GET /users/@me/guilds, GET /guilds/GUILD_ID/channels, GET /channels/CHANNEL_ID/messages?limit=20, POST /channels/CHANNEL_ID/messages {content}.",
    check: { method: "GET", path: "/users/@me", who: (j) => j?.username },
  },
  {
    id: "notion",
    name: "Notion",
    category: "Projects and docs",
    blurb: "Search, read and write pages",
    baseUrl: "https://api.notion.com/v1",
    auth: bearer,
    headers: { "Notion-Version": "2022-06-28" },
    secretLabel: "Integration secret",
    secretPlaceholder: "ntn_…",
    howTo: "In Notion, open Settings, then Connections, then Develop or manage integrations. Create an internal integration and copy its secret. Then share the pages it may use with it.",
    howToUrl: "https://www.notion.so/profile/integrations",
    hint: "Notion API (version 2022-06-28). Only pages shared with the integration are visible. Common: POST /search {query}, GET /pages/ID, GET /blocks/ID/children, POST /pages {parent, properties, children}, PATCH /blocks/ID/children {children}.",
    check: { method: "GET", path: "/users/me", who: (j) => j?.name || j?.bot?.workspace_name },
  },
  {
    id: "linear",
    name: "Linear",
    category: "Projects and docs",
    blurb: "Issues, projects and cycles",
    baseUrl: "https://api.linear.app",
    auth: { kind: "header", header: "Authorization", scheme: "" },
    secretLabel: "API key",
    secretPlaceholder: "lin_api_…",
    howTo: "In Linear, open Settings, then Security and access, and create a personal API key.",
    howToUrl: "https://linear.app/settings/account/security",
    hint: 'Linear GraphQL API: everything is POST /graphql {query, variables}. Examples: { issues(first: 20) { nodes { identifier title state { name } } } }, mutation { issueCreate(input: {teamId: "…", title: "…"}) { issue { identifier url } } }, { teams { nodes { id name } } }.',
    check: { method: "POST", path: "/graphql", body: { query: "{ viewer { name email } }" }, who: (j) => j?.data?.viewer?.name, ok: (s, j) => s < 300 && !!j?.data?.viewer },
  },
  {
    id: "jira",
    name: "Jira",
    category: "Projects and docs",
    blurb: "Issues and projects in Atlassian",
    baseUrl: "https://{site}.atlassian.net/rest/api/3",
    fields: [
      { key: "site", label: "Site", placeholder: "yourteam", hint: "The first part of yourteam.atlassian.net.", pattern: SUB },
      { key: "email", label: "Your Atlassian email", placeholder: "you@company.com", pattern: EMAIL },
    ],
    auth: { kind: "basic", user: "{email}" },
    secretLabel: "API token",
    secretPlaceholder: "Atlassian API token",
    howTo: "In your Atlassian account, open Security, then API tokens, and create a token.",
    howToUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    hint: "Jira Cloud REST API v3. Common: GET /search/jql?jql=assignee=currentUser()&fields=summary,status, GET /issue/KEY-1, POST /issue {fields: {project: {key}, summary, issuetype: {name: 'Task'}}}, POST /issue/KEY-1/comment {body}. Text fields use Atlassian Document Format.",
    check: { method: "GET", path: "/myself", who: (j) => j?.displayName },
  },
  {
    id: "asana",
    name: "Asana",
    category: "Projects and docs",
    blurb: "Tasks and projects",
    baseUrl: "https://app.asana.com/api/1.0",
    auth: bearer,
    secretLabel: "Personal access token",
    secretPlaceholder: "Asana token",
    howTo: "In Asana, open the developer console, create a personal access token and copy it.",
    howToUrl: "https://app.asana.com/0/my-apps",
    hint: "Asana API. Replies are wrapped in data. Common: GET /workspaces, GET /projects?workspace=ID, GET /tasks?project=ID&opt_fields=name,completed, POST /tasks {data: {name, projects: [ID]}}.",
    check: { method: "GET", path: "/users/me", who: (j) => j?.data?.name },
  },
  {
    id: "todoist",
    name: "Todoist",
    category: "Projects and docs",
    blurb: "Personal and team to-dos",
    baseUrl: "https://api.todoist.com/api/v1",
    auth: bearer,
    secretLabel: "API token",
    secretPlaceholder: "Todoist API token",
    howTo: "In Todoist, open Settings, then Integrations, then Developer, and copy your API token.",
    howToUrl: "https://app.todoist.com/app/settings/integrations/developer",
    hint: "Todoist API v1. Lists are paged in results. Common: GET /projects, GET /tasks?project_id=ID, POST /tasks {content, due_string}, POST /tasks/ID/close.",
    check: { method: "GET", path: "/projects", who: (j) => (Array.isArray(j?.results) ? `${j.results.length} projects` : undefined) },
  },
  {
    id: "clickup",
    name: "ClickUp",
    category: "Projects and docs",
    blurb: "Tasks, lists and docs",
    baseUrl: "https://api.clickup.com/api/v2",
    auth: { kind: "header", header: "Authorization", scheme: "" },
    secretLabel: "API token",
    secretPlaceholder: "pk_…",
    howTo: "In ClickUp, open Settings, then Apps, and generate your personal API token.",
    howToUrl: "https://app.clickup.com/settings/apps",
    hint: "ClickUp API v2. Common: GET /team, GET /team/TEAM_ID/space, GET /space/ID/list, GET /list/ID/task, POST /list/ID/task {name, description}.",
    check: { method: "GET", path: "/user", who: (j) => j?.user?.username },
  },
  {
    id: "airtable",
    name: "Airtable",
    category: "Projects and docs",
    blurb: "Bases, tables and records",
    baseUrl: "https://api.airtable.com/v0",
    auth: bearer,
    secretLabel: "Personal access token",
    secretPlaceholder: "pat…",
    howTo: "In Airtable, open the builder hub, create a personal access token with the scopes and bases it needs.",
    howToUrl: "https://airtable.com/create/tokens",
    hint: "Airtable API. Common: GET /meta/bases, GET /meta/bases/BASE_ID/tables, GET /BASE_ID/TABLE?maxRecords=20, POST /BASE_ID/TABLE {records: [{fields}]}.",
    check: { method: "GET", path: "/meta/whoami", who: (j) => j?.email || j?.id },
  },
  {
    id: "hubspot",
    name: "HubSpot",
    category: "Sales and support",
    blurb: "Contacts, companies and deals",
    baseUrl: "https://api.hubapi.com",
    auth: bearer,
    secretLabel: "Private app token",
    secretPlaceholder: "pat-…",
    howTo: "In HubSpot, open Settings, then Integrations, then Private apps. Create an app with the CRM scopes it needs and copy its access token.",
    howToUrl: "https://app.hubspot.com/l/private-apps",
    hint: "HubSpot CRM API v3. Common: GET /crm/v3/objects/contacts?limit=20, POST /crm/v3/objects/contacts/search {filterGroups}, POST /crm/v3/objects/contacts {properties}, GET /crm/v3/objects/deals.",
    check: { method: "GET", path: "/account-info/v3/details", who: (j) => (j?.portalId ? `account ${j.portalId}` : undefined) },
  },
  {
    id: "intercom",
    name: "Intercom",
    category: "Sales and support",
    blurb: "Conversations and contacts",
    baseUrl: "https://api.intercom.io",
    auth: bearer,
    secretLabel: "Access token",
    secretPlaceholder: "Intercom access token",
    howTo: "In the Intercom developer hub, open your app, then Authentication, and copy the access token.",
    howToUrl: "https://app.intercom.com/a/apps/_/developer-hub",
    hint: "Intercom API. Common: GET /conversations?per_page=20, GET /conversations/ID, POST /conversations/ID/reply {message_type: 'comment', type: 'admin', admin_id, body}, POST /contacts/search {query}.",
    check: { method: "GET", path: "/me", who: (j) => j?.name },
  },
  {
    id: "zendesk",
    name: "Zendesk",
    category: "Sales and support",
    blurb: "Support tickets",
    baseUrl: "https://{subdomain}.zendesk.com/api/v2",
    fields: [
      { key: "subdomain", label: "Subdomain", placeholder: "yourteam", hint: "The first part of yourteam.zendesk.com.", pattern: SUB },
      { key: "email", label: "Agent email", placeholder: "you@company.com", pattern: EMAIL },
    ],
    auth: { kind: "basic", user: "{email}/token" },
    secretLabel: "API token",
    secretPlaceholder: "Zendesk API token",
    howTo: "In Zendesk Admin Center, open Apps and integrations, then Zendesk API. Turn on token access, add a token and copy it.",
    howToUrl: "https://support.zendesk.com/hc/en-us/articles/4408889192858",
    hint: "Zendesk Support API v2. Common: GET /tickets.json?sort_by=created_at&sort_order=desc, GET /tickets/ID.json, PUT /tickets/ID.json {ticket: {comment: {body, public}}}, GET /search.json?query=status:open.",
    check: { method: "GET", path: "/users/me.json", who: (j) => (j?.user?.id ? j.user.name : undefined) },
  },
  {
    id: "calendly",
    name: "Calendly",
    category: "Sales and support",
    blurb: "Meetings and booking links",
    baseUrl: "https://api.calendly.com",
    auth: bearer,
    secretLabel: "Personal access token",
    secretPlaceholder: "Calendly token",
    howTo: "In Calendly, open Integrations, then API and webhooks, and generate a personal access token.",
    howToUrl: "https://calendly.com/integrations/api_webhooks",
    hint: "Calendly API v2. Start with GET /users/me for your user URI. Common: GET /scheduled_events?user=URI&status=active, GET /event_types?user=URI.",
    check: { method: "GET", path: "/users/me", who: (j) => j?.resource?.name },
  },
  {
    id: "stripe",
    name: "Stripe",
    category: "Payments and shops",
    blurb: "Payments, customers and invoices",
    baseUrl: "https://api.stripe.com/v1",
    auth: bearer,
    bodyFormat: "form",
    secretLabel: "Restricted key",
    secretPlaceholder: "rk_live_…",
    howTo: "In Stripe, open Developers, then API keys, and create a restricted key with read access to what agents need. Avoid the full secret key.",
    howToUrl: "https://dashboard.stripe.com/apikeys",
    hint: "Stripe API. POST bodies are sent as form fields (nested keys like metadata[order]=1 work). Common: GET /balance, GET /charges?limit=10, GET /customers?email=a@b.com, GET /invoices?limit=10, GET /subscriptions?status=active.",
    check: { method: "GET", path: "/balance", who: (j) => (j?.object === "balance" ? (j.livemode ? "live account" : "test account") : undefined) },
  },
  {
    id: "shopify",
    name: "Shopify",
    category: "Payments and shops",
    blurb: "Orders, products and customers",
    baseUrl: "https://{shop}.myshopify.com/admin/api/2025-07",
    fields: [{ key: "shop", label: "Store", placeholder: "yourstore", hint: "The first part of yourstore.myshopify.com.", pattern: SUB }],
    auth: { kind: "header", header: "X-Shopify-Access-Token", scheme: "" },
    secretLabel: "Admin API access token",
    secretPlaceholder: "shpat_…",
    howTo: "In Shopify admin, open Settings, then Apps and sales channels, then Develop apps. Create an app, give it Admin API scopes, install it and copy the access token.",
    howToUrl: "https://help.shopify.com/en/manual/apps/app-types/custom-apps",
    hint: "Shopify Admin REST API 2025-07. Common: GET /orders.json?status=any&limit=20, GET /orders/ID.json, GET /products.json?limit=20, GET /customers/search.json?query=email:a@b.com.",
    check: { method: "GET", path: "/shop.json", who: (j) => j?.shop?.name },
  },
  {
    id: "mailchimp",
    name: "Mailchimp",
    category: "Email and texts",
    blurb: "Audiences and campaigns",
    baseUrl: "https://{dc}.api.mailchimp.com/3.0",
    auth: { kind: "basic", user: "circlechat" },
    secretLabel: "API key",
    secretPlaceholder: "…-us21",
    howTo: "In Mailchimp, open your profile, then Extras, then API keys, and create a key.",
    howToUrl: "https://admin.mailchimp.com/account/api/",
    hint: "Mailchimp Marketing API 3.0. Common: GET /lists, GET /lists/LIST_ID/members?count=20, POST /lists/LIST_ID/members {email_address, status: 'subscribed'}, GET /campaigns?count=10.",
    derive: (secret): Record<string, string> => {
      const m = /-([a-z]{2,4}\d{1,3})$/i.exec(secret.trim());
      return m ? { dc: m[1].toLowerCase() } : {};
    },
    check: { method: "GET", path: "/", who: (j) => j?.account_name },
  },
  {
    id: "resend",
    name: "Resend",
    category: "Email and texts",
    blurb: "Send email from your domain",
    baseUrl: "https://api.resend.com",
    auth: bearer,
    secretLabel: "API key",
    secretPlaceholder: "re_…",
    howTo: "In Resend, open API keys and create a key. Sending access is enough for sending email.",
    howToUrl: "https://resend.com/api-keys",
    hint: "Resend API. Send: POST /emails {from: 'Name <you@yourdomain.com>', to: ['a@b.com'], subject, html or text}. The from address must be on a verified domain.",
    check: {
      method: "GET",
      path: "/domains",
      who: (j) => (Array.isArray(j?.data) ? j.data.map((d: any) => d.name).join(", ") || "no domains yet" : j?.name === "restricted_api_key" ? "sending-only key" : undefined),
      // a sending-only key can't list domains, but it is a real key
      ok: (s, j) => s < 300 || j?.name === "restricted_api_key",
    },
  },
  {
    id: "twilio",
    name: "Twilio",
    category: "Email and texts",
    blurb: "Send texts and check messages",
    baseUrl: "https://api.twilio.com/2010-04-01/Accounts/{sid}",
    fields: [{ key: "sid", label: "Account SID", placeholder: "AC…", pattern: /^AC[0-9a-f]{32}$/i }],
    auth: { kind: "basic", user: "{sid}" },
    bodyFormat: "form",
    secretLabel: "Auth token",
    secretPlaceholder: "Twilio auth token",
    howTo: "In the Twilio console, the Account SID and Auth token are on the account dashboard.",
    howToUrl: "https://console.twilio.com/",
    hint: "Twilio API 2010-04-01, scoped to this account. POST bodies are form fields. Send a text: POST /Messages.json {To: '+15551234567', From: '+15557654321', Body}. List: GET /Messages.json?PageSize=20.",
    check: { method: "GET", path: ".json", who: (j) => j?.friendly_name },
  },
];

export function preset(id: string): AppPreset | undefined {
  return APP_CATALOG.find((p) => p.id === id);
}

const fill = (tpl: string, vals: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k) => vals[k] ?? "");

/** Turn a preset plus what the person typed into an HTTP connection config. Throws on bad input. */
export function presetConfig(p: AppPreset, input: Record<string, unknown>, secret: string): Record<string, any> {
  const vals: Record<string, string> = { ...(p.derive?.(secret) ?? {}) };
  for (const f of p.fields ?? []) {
    const v = String(input[f.key] ?? "").trim();
    if (!f.pattern.test(v)) throw new Error(`${f.label} doesn't look right`);
    vals[f.key] = v;
  }
  for (const k of p.baseUrl.match(/\{(\w+)\}/g) ?? []) {
    const key = k.slice(1, -1);
    if (!vals[key]) throw new Error(p.id === "mailchimp" ? "That API key should end with its data centre, like -us21" : `missing ${key}`);
    if (!/^[a-z0-9-]+$/i.test(vals[key])) throw new Error(`${key} doesn't look right`);
  }
  const cfg: Record<string, any> = {
    preset: p.id,
    baseUrl: fill(p.baseUrl, vals),
    hint: p.hint,
    fields: Object.fromEntries((p.fields ?? []).map((f) => [f.key, vals[f.key]])),
  };
  if (p.auth.kind === "header") {
    cfg.authHeader = p.auth.header;
    cfg.authScheme = p.auth.scheme;
  } else {
    cfg.authBasicUser = fill(p.auth.user, vals);
  }
  if (p.headers) cfg.headers = p.headers;
  if (p.bodyFormat === "form") cfg.bodyFormat = "form";
  return cfg;
}

/** The auth and extra headers for a connection's config and secret. */
export function connectionHeaders(cfg: any, secret: string): Record<string, string> {
  const h: Record<string, string> = { ...(cfg.headers ?? {}) };
  if (!secret) return h;
  if (cfg.authBasicUser) h.Authorization = "Basic " + Buffer.from(`${cfg.authBasicUser}:${secret}`).toString("base64");
  else h[cfg.authHeader || "Authorization"] = (cfg.authScheme ?? "Bearer ") + secret;
  return h;
}

/** Form-encode a JSON body the way Stripe and Twilio expect (a[b]=c for nested objects). */
export function formEncode(body: unknown): string {
  const out = new URLSearchParams();
  const walk = (v: unknown, key: string) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${key}[${i}]`));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v as object)) walk(x, key ? `${key}[${k}]` : k);
    else out.append(key, String(v));
  };
  walk(body, "");
  return out.toString();
}

/** Call the preset's "who am I" endpoint. */
export async function checkPreset(p: AppPreset, cfg: any, secret: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; detail: string }> {
  const url = cfg.baseUrl + fill(p.check.path, cfg.fields ?? {});
  const res = await fetchImpl(url, {
    method: p.check.method,
    headers: {
      ...connectionHeaders(cfg, secret),
      accept: "application/json",
      ...(p.check.body ? { "content-type": "application/json" } : {}),
    },
    body: p.check.body ? JSON.stringify(p.check.body) : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let j: any = null;
  try {
    j = JSON.parse(text);
  } catch {}
  const ok = p.check.ok ? p.check.ok(res.status, j) : res.status >= 200 && res.status < 300;
  if (ok) {
    const who = p.check.who(j);
    return { ok: true, detail: who ? `Connected: ${who}` : "Connected" };
  }
  // some APIs answer a bad key with 400 (Cloudflare, Resend), Slack with 200 and ok: false
  const badKey = res.status === 400 && /invalid[^"]*(key|token|header|auth)|(key|token)[^"]*invalid|authori[sz]ation/i.test(text);
  if (res.status === 401 || res.status === 403 || badKey || j?.error === "invalid_auth" || j?.ok === false)
    return { ok: false, detail: `${p.name} didn't accept that token (${res.status}${j?.error && typeof j.error === "string" ? ", " + j.error : ""}).` };
  if (res.status === 404 && p.fields?.length)
    return { ok: false, detail: `${p.name} couldn't find that ${p.fields[0].label.toLowerCase()}. Check the spelling.` };
  return { ok: false, detail: `${p.name} answered ${res.status}. Check the details and try again.` };
}
