"use client";

import { useState } from "react";
import TrackSearch from "@/components/TrackSearch";
import MashupLibrary from "@/components/MashupLibrary";

const TABS = [
  { id: "add", label: "Add Songs" },
  { id: "mashup", label: "Build Mashup" },
];

export default function Workbench() {
  const [tab, setTab] = useState("add");

  return (
    <div className="w-full max-w-xl space-y-6">
      <div className="flex justify-center gap-1 rounded-lg border border-stone-800 bg-stone-900/60 p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.id ? "bg-stone-100 text-stone-900" : "text-stone-400 hover:text-stone-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "add" ? <TrackSearch /> : <MashupLibrary />}
    </div>
  );
}
