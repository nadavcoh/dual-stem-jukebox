import TrackSearch from "@/components/TrackSearch";

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-stone-950 px-6 py-16">
      <p className="mb-1 font-mono text-[11px] uppercase tracking-widest text-stone-500">
        Dual-Stem Interactive Jukebox
      </p>
      <h1 className="mb-8 text-2xl font-semibold text-stone-100">
        Pick two tracks. We'll find where they fit.
      </h1>
      <TrackSearch />
    </main>
  );
}
