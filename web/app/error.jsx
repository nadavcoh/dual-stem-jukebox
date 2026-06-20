"use client";

export default function Error({ error, reset }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-stone-950 p-6 text-center">
      <p className="font-mono text-[11px] uppercase tracking-widest text-stone-500">
        Something went wrong
      </p>
      <p className="max-w-sm text-sm text-stone-300">
        {error?.message ?? "An unexpected error occurred."}
      </p>
      <button
        onClick={reset}
        className="rounded-md bg-stone-100 px-4 py-2 text-sm font-medium text-stone-900"
      >
        Try again
      </button>
    </main>
  );
}
