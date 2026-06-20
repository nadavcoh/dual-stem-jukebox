import { supabaseAdmin } from "@/lib/supabaseServer";
import { buildCrossTrackJumpMap } from "@/lib/crossTrackMatrix";
import JukeboxPlayer from "@/components/JukeboxPlayer";

export default async function JukeboxPage({ params }) {
  const { idA, idB } = params;
  const supabase = supabaseAdmin();

  const { data: rows, error } = await supabase
    .from("tracks")
    .select("*")
    .in("youtube_id", [idA, idB]);

  if (error) {
    return <ErrorState message={error.message} />;
  }

  const byId = Object.fromEntries((rows ?? []).map((r) => [r.youtube_id, r]));
  const trackA = byId[idA];
  const trackB = byId[idB];

  if (!trackA || !trackB || trackA.status !== "completed" || trackB.status !== "completed") {
    return (
      <ErrorState message="One or both tracks aren't finished processing yet. Head back to search and wait for the worker to finish." />
    );
  }

  // matrix.json holds the beat-synchronous features the worker computed —
  // we fetch both and build the A<->B jump map here, server-side, once per
  // page load, rather than shipping raw feature vectors to the browser.
  const [matrixA, matrixB] = await Promise.all([
    fetch(trackA.matrix_json_url).then((r) => r.json()),
    fetch(trackB.matrix_json_url).then((r) => r.json()),
  ]);

  const jumpMap = buildCrossTrackJumpMap(matrixA, matrixB);

  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-950 p-6">
      <JukeboxPlayer
        trackA={{
          title: trackA.title ?? trackA.youtube_id,
          vocalsUrl: trackA.vocals_url,
          instrumentalUrl: trackA.instrumental_url,
        }}
        trackB={{
          title: trackB.title ?? trackB.youtube_id,
          vocalsUrl: trackB.vocals_url,
          instrumentalUrl: trackB.instrumental_url,
        }}
        jumpMap={jumpMap}
      />
    </main>
  );
}

function ErrorState({ message }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-950 p-6">
      <p className="max-w-md text-center text-sm text-stone-400">{message}</p>
    </main>
  );
}
