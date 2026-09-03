import { webConfig } from '../lib/env';

export default function AdminHomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl items-center px-8">
      <section className="w-full rounded-2xl border border-amber-200/20 bg-slate-950/80 p-10 shadow-2xl">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-amber-300">
          Owner boundary
        </p>
        <h1 className="mt-3 text-3xl font-semibold">Admin foundation online</h1>
        <p className="mt-4 max-w-2xl leading-7 text-slate-300">
          Authentication, operational controls, approvals, and all financial actions are withheld
          until their approved implementation phases. This surface currently proves only its
          isolated deployment and observability boundary.
        </p>
        <p className="mt-6 text-xs text-slate-500">
          API: {new URL(webConfig.NEXT_PUBLIC_API_BASE_URL).origin}
        </p>
      </section>
    </main>
  );
}
