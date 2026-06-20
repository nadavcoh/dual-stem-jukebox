import "./globals.css";

export const metadata = {
  title: "Dual-Stem Interactive Jukebox",
  description: "Generative music mashups, beat-synced and stem-separated.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
