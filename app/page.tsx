"use client";

import { useId, useState } from "react";

type DraftState = {
  place_name: string;
  photos: string[];
  captions: string[];
  highlights: string[];
  category: string;
  tone: string;
  language: string;
  urls: string[];
};

function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export default function Home() {
  const placeNameId = useId();
  const photosId = useId();
  const captionsId = useId();
  const highlightsId = useId();
  const categoryId = useId();
  const toneId = useId();
  const languageId = useId();
  const urlsId = useId();

  const [placeName, setPlaceName] = useState("");
  const [photosText, setPhotosText] = useState("");
  const [captionsText, setCaptionsText] = useState("");
  const [highlightsText, setHighlightsText] = useState("");
  const [category, setCategory] = useState("");
  const [tone, setTone] = useState("");
  const [language, setLanguage] = useState("");
  const [urlsText, setUrlsText] = useState("");

  function onGenerateClick(): void {
    const draft: DraftState = {
      place_name: placeName,
      photos: splitLines(photosText),
      captions: splitLines(captionsText),
      highlights: splitLines(highlightsText),
      category,
      tone,
      language,
      urls: splitLines(urlsText),
    };

    // Intentionally no network calls in this packet.
    console.log("draft.generate", draft);
  }

  return (
    <div className="min-h-screen bg-zinc-50 font-sans text-zinc-950 dark:bg-black dark:text-zinc-50">
      <main className="mx-auto w-full max-w-3xl px-6 py-12">
        <header className="mb-10">
          <h1 className="text-2xl font-semibold tracking-tight">
            Create New Draft
          </h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Web-only draft form skeleton. Click Generate to log the current form
            state.
          </p>
        </header>

        <form
          className="space-y-6"
          onSubmit={(e) => {
            e.preventDefault();
            onGenerateClick();
          }}
        >
          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor={placeNameId}>
              place_name
            </label>
            <input
              id={placeNameId}
              name="place_name"
              className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
              value={placeName}
              onChange={(e) => setPlaceName(e.target.value)}
              placeholder="e.g. Blue Bottle Coffee"
            />
          </div>

          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="block text-sm font-medium" htmlFor={categoryId}>
                category
              </label>
              <input
                id={categoryId}
                name="category"
                className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g. cafe"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium" htmlFor={toneId}>
                tone
              </label>
              <input
                id={toneId}
                name="tone"
                className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
                value={tone}
                onChange={(e) => setTone(e.target.value)}
                placeholder="e.g. friendly"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor={languageId}>
              language
            </label>
            <input
              id={languageId}
              name="language"
              className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="e.g. en"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor={photosId}>
              photos
            </label>
            <textarea
              id={photosId}
              name="photos"
              className="min-h-24 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
              value={photosText}
              onChange={(e) => setPhotosText(e.target.value)}
              placeholder="One photo URL or path per line"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor={captionsId}>
              captions
            </label>
            <textarea
              id={captionsId}
              name="captions"
              className="min-h-24 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
              value={captionsText}
              onChange={(e) => setCaptionsText(e.target.value)}
              placeholder="One caption per line"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor={highlightsId}>
              highlights
            </label>
            <textarea
              id={highlightsId}
              name="highlights"
              className="min-h-24 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
              value={highlightsText}
              onChange={(e) => setHighlightsText(e.target.value)}
              placeholder="One highlight per line"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor={urlsId}>
              urls
            </label>
            <textarea
              id={urlsId}
              name="urls"
              className="min-h-24 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
              value={urlsText}
              onChange={(e) => setUrlsText(e.target.value)}
              placeholder="One related URL per line"
            />
          </div>

          <div className="pt-2">
            <button
              type="submit"
              className="inline-flex items-center justify-center rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200"
            >
              Generate
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
