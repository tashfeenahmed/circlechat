import { useMe } from "../lib/hooks";

export default function SettingsPage() {
  const me = useMe();
  return (
    <main className="flex-1 overflow-auto bg-white">
      <div className="max-w-[640px] mx-auto px-8 py-8">
        <h1 className="text-[22px] font-semibold mb-1">Settings</h1>
        <p className="text-[13px] text-[var(--color-muted)] mb-6">
          Profile and notification preferences.
        </p>

        <section className="border border-[var(--color-hair)] rounded p-4 mb-4">
          <h2 className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-2">Profile</h2>
          {me.data && (
            <dl className="grid grid-cols-[120px_1fr] gap-y-1 text-[13px]">
              <dt className="text-[var(--color-muted)]">Name</dt>
              <dd>{me.data.user.name}</dd>
              <dt className="text-[var(--color-muted)]">Handle</dt>
              <dd className="font-mono">@{me.data.user.handle}</dd>
              <dt className="text-[var(--color-muted)]">Email</dt>
              <dd>{me.data.user.email}</dd>
            </dl>
          )}
        </section>

        <section className="border border-[var(--color-hair)] rounded p-4 mb-4">
          <h2 className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-2">Notifications</h2>
          <p className="text-[13px] text-[var(--color-muted)]">
            Browser notifications and email digests ship in M3.
          </p>
        </section>

        <section className="border border-[var(--color-hair)] rounded p-4">
          <h2 className="text-[11px] uppercase tracking-wider text-[var(--color-muted)] font-mono mb-2">Theme</h2>
          <p className="text-[13px] text-[var(--color-muted)]">Light theme · Notion-gray palette (MVP).</p>
        </section>
      </div>
    </main>
  );
}
