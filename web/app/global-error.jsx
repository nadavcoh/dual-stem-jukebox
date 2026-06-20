"use client";

export default function GlobalError({ error, reset }) {
  return (
    <html lang="en">
      <body style={{ background: "#0c0a09", color: "#e7e5e4" }}>
        <main
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "1rem",
            padding: "1.5rem",
            textAlign: "center",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <p style={{ fontSize: "0.875rem", color: "#d4d4d4" }}>
            {error?.message ?? "An unexpected error occurred."}
          </p>
          <button
            onClick={reset}
            style={{
              borderRadius: "0.375rem",
              background: "#f5f5f4",
              color: "#1c1917",
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
              fontWeight: 500,
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
