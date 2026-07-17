"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type Source = {
  title: string;
  url: string;
};

type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
};

const PLATFORMS: { group: string; items: string[] }[] = [
  {
    group: "Nintendo",
    items: [
      "NES",
      "SNES",
      "Nintendo 64",
      "GameCube",
      "Wii",
      "Wii U",
      "Nintendo Switch",
      "Nintendo Switch 2",
      "Game Boy",
      "Game Boy Color",
      "Game Boy Advance",
      "Nintendo DS",
      "Nintendo 3DS",
    ],
  },
  {
    group: "PlayStation",
    items: [
      "PlayStation (PS1)",
      "PlayStation 2",
      "PlayStation 3",
      "PlayStation 4",
      "PlayStation 5",
      "PSP",
      "PS Vita",
    ],
  },
  {
    group: "Xbox",
    items: ["Xbox", "Xbox 360", "Xbox One", "Xbox Series X|S"],
  },
  {
    group: "Sega",
    items: ["Sega Genesis / Mega Drive", "Sega Saturn", "Dreamcast"],
  },
  {
    group: "Lainnya",
    items: ["PC", "Mobile (iOS/Android)", "Arcade"],
  },
];

const examples = [
  { game: "The Legend of Zelda: Link's Awakening", platform: "Game Boy", q: "Bagaimana cara masuk ke dungeon pertama?" },
  { game: "Final Fantasy VII", platform: "PlayStation (PS1)", q: "Cara mengalahkan Emerald Weapon" },
  { game: "Elden Ring", platform: "PC", q: "Build terbaik untuk pemula" },
];

function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "web";
  }
}

export default function Home() {
  const [game, setGame] = useState("");
  const [platform, setPlatform] = useState("");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    feedRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = input.trim();
    if (question.length < 2 || loading) return;

    setError("");
    setLoading(true);
    const history = messages.slice(-10).map(({ role, content }) => ({ role, content }));
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setInput("");

    try {
      const response = await fetch("/api/solve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ game, platform, question, history }),
      });
      const data: unknown = await response.json();

      if (
        !response.ok ||
        !data ||
        typeof data !== "object" ||
        !("summary" in data) ||
        typeof data.summary !== "string"
      ) {
        const message =
          data &&
          typeof data === "object" &&
          "error" in data &&
          typeof data.error === "string"
            ? data.error
            : "Panduan belum dapat dibuat. Coba lagi.";
        throw new Error(message);
      }

      const sources =
        "sources" in data && Array.isArray(data.sources)
          ? (data.sources as Source[])
          : [];
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.summary as string, sources },
      ]);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Terjadi kesalahan yang tidak diketahui.",
      );
    } finally {
      setLoading(false);
    }
  }

  const started = messages.length > 0;

  return (
    <main>
      <nav className="nav" aria-label="Brand">
        <a className="brand" href="#" aria-label="GameGuide Guru, beranda">
          <span className="brand-mark" aria-hidden="true">
            G
          </span>
          <span>GAMEGUIDE GURU</span>
        </a>
        <span className="live-badge">
          <span aria-hidden="true" />
          WEB LIVE
        </span>
      </nav>

      {!started && (
        <section className="hero">
          <p className="eyebrow">COMPANION UNTUK PETUALANG</p>
          <h1>
            Macet? <em>Lanjut main.</em>
          </h1>
          <p className="intro">
            Pilih game dan platformmu, ceritakan titik buntumu, lalu tanya lanjutan
            sepuasnya. Kami mencari panduan di web dan merangkumnya jadi langkah
            yang siap dimainkan.
          </p>
        </section>
      )}

      <section className="setup" aria-label="Konteks game">
        <div className="field">
          <label htmlFor="game">Nama game</label>
          <input
            id="game"
            name="game"
            value={game}
            onChange={(event) => setGame(event.target.value)}
            placeholder="mis. The Legend of Zelda: Link's Awakening"
            maxLength={120}
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label htmlFor="platform">Platform</label>
          <select
            id="platform"
            name="platform"
            value={platform}
            onChange={(event) => setPlatform(event.target.value)}
          >
            <option value="">Pilih platform (opsional)</option>
            {PLATFORMS.map((section) => (
              <optgroup key={section.group} label={section.group}>
                {section.items.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      </section>

      {!started && (
        <div className="examples-block" aria-label="Contoh">
          <span className="examples-label">Coba contoh</span>
          <div className="examples">
            {examples.map((example) => (
              <button
                key={example.q}
                type="button"
                onClick={() => {
                  setGame(example.game);
                  setPlatform(example.platform);
                  setInput(example.q);
                }}
                disabled={loading}
              >
                <strong>{example.game}</strong>
                <span>{example.q}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {started && (
        <section className="feed" aria-live="polite">
          {messages.map((message, index) =>
            message.role === "user" ? (
              <div className="turn user" key={index}>
                <p>{message.content}</p>
              </div>
            ) : (
              <article className="turn guide" key={index}>
                <div className="guide-tag">
                  <span aria-hidden="true">◆</span> RUTE DITEMUKAN
                </div>
                <div className="answer">{message.content}</div>
                {message.sources && message.sources.length > 0 && (
                  <footer>
                    <h2>Sumber</h2>
                    <ol>
                      {message.sources.map((source, i) => (
                        <li key={source.url}>
                          <a href={source.url} target="_blank" rel="noreferrer">
                            <span className="source-number">
                              {String(i + 1).padStart(2, "0")}
                            </span>
                            <span>
                              <strong>{source.title}</strong>
                              <small>{hostname(source.url)}</small>
                            </span>
                            <span className="source-arrow" aria-hidden="true">
                              ↗
                            </span>
                          </a>
                        </li>
                      ))}
                    </ol>
                  </footer>
                )}
              </article>
            ),
          )}

          {loading && (
            <div className="turn guide loading-card">
              <span className="scan-line" aria-hidden="true" />
              <p>Menjelajahi walkthrough dan forum pemain...</p>
            </div>
          )}

          {error && (
            <div className="error-card" role="alert">
              <span aria-hidden="true">!</span>
              <p>{error}</p>
            </div>
          )}
          <div ref={feedRef} />
        </section>
      )}

      <form className={`composer${started ? " docked" : ""}`} onSubmit={handleSubmit}>
        <div className="composer-inner">
          <textarea
            id="query"
            name="query"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={
              started
                ? "Tanya lanjutan... (mis. lalu setelah bos itu ke mana?)"
                : "Di mana kamu terjebak?"
            }
            rows={started ? 1 : 3}
            maxLength={300}
            required
            disabled={loading}
          />
          <button
            className="submit"
            type="submit"
            disabled={loading || input.trim().length < 2}
            aria-label="Kirim pertanyaan"
          >
            {loading ? (
              <span className="loader" aria-hidden="true" />
            ) : (
              <span className="arrow" aria-hidden="true">
                ↗
              </span>
            )}
          </button>
        </div>
      </form>

      <p className="disclaimer">
        Panduan dirangkum oleh AI. Periksa sumber untuk detail versi game.
      </p>
    </main>
  );
}
