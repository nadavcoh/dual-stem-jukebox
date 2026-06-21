import "server-only";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Short-lived on purpose: these are generated just before playback starts
// (JukeboxPlayer's "Load & Play" handler), not baked into a page render
// that might sit open in a tab for a while before anyone clicks play.
const DEFAULT_EXPIRES_IN_SECONDS = 300; // 5 minutes

let cachedClient = null;

/**
 * B2's dashboard shows the bucket's "Endpoint" field as a bare hostname —
 * e.g. "s3.eu-central-003.backblazeb2.com" — with no scheme. The AWS SDK's
 * `endpoint` option needs a full URL though; passed the bare hostname, it
 * throws `TypeError [ERR_INVALID_URL]` the moment anything tries to build
 * a request. Tolerate both forms here instead of relying on everyone who
 * ever sets this env var to know to prepend https://.
 */
function normalizeEndpoint(value) {
  if (!value) return value;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/**
 * Read-only S3 client for the private B2 bucket. Deliberately uses its
 * own separate, read-only application key — B2_READ_KEY_ID /
 * B2_READ_APPLICATION_KEY — distinct from the read-write key pair the
 * Python worker uses. Even if this key leaked from a bundled/inspectable
 * spot, it can only ever generate GET URLs, never upload or delete.
 */
function getReadOnlyClient() {
  if (!cachedClient) {
    cachedClient = new S3Client({
      endpoint: normalizeEndpoint(process.env.B2_ENDPOINT_URL),
      region: process.env.B2_REGION,
      forcePathStyle: true, // required for B2's S3-compatible endpoint
      credentials: {
        accessKeyId: process.env.B2_READ_KEY_ID,
        secretAccessKey: process.env.B2_READ_APPLICATION_KEY,
      },
    });
  }
  return cachedClient;
}

/**
 * Exchange a single B2 object key for a temporary presigned GET URL.
 * @param {string} key e.g. "dQw4w9WgXcQ/vocals.mp3"
 * @param {number} [expiresInSeconds]
 * @returns {Promise<string>}
 */
export async function getPresignedUrl(key, expiresInSeconds = DEFAULT_EXPIRES_IN_SECONDS) {
  const client = getReadOnlyClient();
  const command = new GetObjectCommand({
    Bucket: process.env.B2_BUCKET_NAME,
    Key: key,
  });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

/**
 * Batch version — resolves multiple keys in parallel and returns a
 * key -> presignedUrl map. Falsy keys (e.g. a track that hasn't finished
 * processing) are skipped rather than throwing.
 * @param {Array<string|null|undefined>} keys
 * @param {number} [expiresInSeconds]
 * @returns {Promise<Record<string, string>>}
 */
export async function getPresignedUrls(keys, expiresInSeconds = DEFAULT_EXPIRES_IN_SECONDS) {
  const unique = [...new Set((keys ?? []).filter(Boolean))];
  const entries = await Promise.all(
    unique.map(async (key) => [key, await getPresignedUrl(key, expiresInSeconds)])
  );
  return Object.fromEntries(entries);
}
