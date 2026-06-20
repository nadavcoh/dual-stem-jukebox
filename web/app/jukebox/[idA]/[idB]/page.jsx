import { supabaseAdmin } from "@/lib/supabaseServer";
import { getPresignedUrl } from "@/lib/b2Presign";
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

  // matrix.json holds the beat-synchronous features the worker computed.
  // The bucket is private, so we exchange each matrix_json_key for a
  // short-lived presigned URL (using the read-only B2 key) before
  // fetching it — this happens server-side, once per page load.
  const [matrixUrlA, matrixUrlB] = await Promise.all([
    getPresignedUrl(trackA.matrix_json_key),
    getPresignedUrl(trackB.matrix_json_key),
  ]);

  const [matrixA, matrixB] = await Promise.all([
    fetch(matrixUrlA).then((r) => r.json()),
    fetch(matrixUrlB).then((r) => r.json()),
  ]);

  const jumpMap = buildCrossTrackJumpMap(matrixA, matrixB);

  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-950 p-6">
      <JukeboxPlayer
        trackA={{
          title: trackA.title ?? trackA.youtube_id,
          vocalsKey: trackA.vocals_key,
          instrumentalKey: trackA.instrumental_key,
        }}
        trackB={{
          title: trackB.title ?? trackB.youtube_id,
          vocalsKey: trackB.vocals_key,
          instrumentalKey: trackB.instrumental_key,
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
