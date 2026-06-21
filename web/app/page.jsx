import Workbench from "@/components/Workbench";

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-stone-950 px-6 py-16">
      <p className="mb-1 font-mono text-[11px] uppercase tracking-widest text-stone-500">
        Dual-Stem Interactive Jukebox
      </p>
      <h1 className="mb-8 text-center text-2xl font-semibold text-stone-100">
        Add songs to the library, then mash up what's ready.
      </h1>
      <Workbench />
    </main>
  );
}
