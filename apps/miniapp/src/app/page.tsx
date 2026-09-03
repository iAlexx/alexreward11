import { webConfig } from '../lib/env';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg items-center px-6">
      <section className="w-full rounded-3xl border border-sky-300/20 bg-slate-950/70 p-8 shadow-2xl backdrop-blur">
        <p className="text-sm font-semibold uppercase tracking-[0.25em] text-sky-300">
          ALEx Rewards
        </p>
        <h1 className="mt-3 text-3xl font-semibold">Foundation online</h1>
        <p className="mt-4 leading-7 text-slate-300">
          Phase 1 establishes the secure application boundary. Rewards, balances, ads, and payouts
          are intentionally unavailable until their approved phases.
        </p>
        <p className="mt-6 text-xs text-slate-500">
          API: {new URL(webConfig.NEXT_PUBLIC_API_BASE_URL).origin}
        </p>
      </section>
    </main>
  );
}
