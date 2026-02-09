"use client";

import { useState } from "react";

interface DraftFormState {
  place_name: string;
  photos: string;
  captions: string;
  highlights: string;
  category: string;
  tone: string;
  language: string;
  urls: string;
}

const initialState: DraftFormState = {
  place_name: "",
  photos: "",
  captions: "",
  highlights: "",
  category: "",
  tone: "",
  language: "",
  urls: "",
};

export default function CreateNewDraftPage() {
  const [form, setForm] = useState<DraftFormState>(initialState);

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function handleGenerate() {
    // Read current form state — no API call is made
    // eslint-disable-next-line no-console
    console.log("Draft state:", form);
  }

  return (
    <main style={{ maxWidth: 600, margin: "0 auto", padding: 24 }}>
      <h1>Create New Draft</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleGenerate();
        }}
      >
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="place_name">Place Name</label>
          <br />
          <input
            id="place_name"
            name="place_name"
            type="text"
            value={form.place_name}
            onChange={handleChange}
            style={{ width: "100%" }}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label htmlFor="photos">Photos</label>
          <br />
          <input
            id="photos"
            name="photos"
            type="text"
            value={form.photos}
            onChange={handleChange}
            style={{ width: "100%" }}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label htmlFor="captions">Captions</label>
          <br />
          <textarea
            id="captions"
            name="captions"
            value={form.captions}
            onChange={handleChange}
            rows={3}
            style={{ width: "100%" }}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label htmlFor="highlights">Highlights</label>
          <br />
          <textarea
            id="highlights"
            name="highlights"
            value={form.highlights}
            onChange={handleChange}
            rows={3}
            style={{ width: "100%" }}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label htmlFor="category">Category</label>
          <br />
          <input
            id="category"
            name="category"
            type="text"
            value={form.category}
            onChange={handleChange}
            style={{ width: "100%" }}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label htmlFor="tone">Tone</label>
          <br />
          <input
            id="tone"
            name="tone"
            type="text"
            value={form.tone}
            onChange={handleChange}
            style={{ width: "100%" }}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label htmlFor="language">Language</label>
          <br />
          <input
            id="language"
            name="language"
            type="text"
            value={form.language}
            onChange={handleChange}
            style={{ width: "100%" }}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label htmlFor="urls">URLs</label>
          <br />
          <textarea
            id="urls"
            name="urls"
            value={form.urls}
            onChange={handleChange}
            rows={2}
            style={{ width: "100%" }}
          />
        </div>

        <button type="submit">Generate</button>
      </form>
    </main>
  );
}
