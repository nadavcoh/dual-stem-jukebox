const ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;

/**
 * Pulls an 11-character YouTube video id out of a full URL (watch, youtu.be,
 * shorts, embed) or returns the input unchanged if it's already a bare id.
 */
export function extractYouTubeId(input) {
  if (!input) return null;
  const value = input.trim();

  if (ID_PATTERN.test(value)) return value;

  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match[1];
  }
  return null;
}
