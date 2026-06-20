/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
  // yt-search (and its dependency cheerio) has a dependency tree that
  // Vercel's serverless function file-tracing tends to under-include when
  // it's bundled by webpack/Turbopack — the symptom is "Cannot find module
  // 'cheerio'" at runtime even though it installs fine. Marking it external
  // tells Next.js to require() it directly from node_modules at runtime
  // instead, which is the documented fix for this whole class of issue
  // (the same option Next's own docs recommend for sharp, canvas, etc.).
  serverExternalPackages: ["yt-search", "cheerio"],
};

module.exports = nextConfig;
