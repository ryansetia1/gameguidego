# GameGuide Guru

Prototipe companion game mobile-first. Model AI di Replicate (default
`google/gemini-2.5-flash`) menjawab dari pengetahuannya sendiri, dan hasil
pencarian web Tavily dipakai sebagai bukti pendukung.

## Fitur

- Field nama game dengan autocomplete dari database game IGDB, dan selector
  platform yang bisa dicari (custom combobox bertema, dari era NES sampai
  Switch 2, PS5, Xbox Series, PC, dan lainnya).
- Chat lanjutan multi-turn: konteks hingga 5 percakapan terakhir dikirim ke
  model sehingga pertanyaan lanjutan seperti "lalu setelah bos itu ke mana?"
  tetap dipahami.
- Pencarian berjenjang: GameFAQs sebagai sumber utama, lalu penyedia walkthrough
  tepercaya, lalu forum, baru pencarian umum. Domain video/sosial (YouTube,
  Twitch, dll.) dikecualikan karena model teks tidak bisa membacanya.
- Penyaringan noise: ekstraksi konten pakai Tavily `advanced`, hasil difilter
  berdasarkan skor relevansi (membuang game lain yang tidak nyambung), snippet
  dibersihkan dari link/menu/boilerplate, hasil didedup per judul+URL, dan hanya
  3 sumber terkuat yang dikirim ke model.
- Confidence gate: kalau tidak ada satu pun sumber yang jelas relevan, sumber
  dikosongkan dan model menjawab dari pengetahuannya sendiri (atau jujur bilang
  tidak tahu) daripada dipaksa memakai snippet yang setengah relevan.
- Pengetahuan model sebagai sumber utama, web sebagai pendukung untuk info yang
  mungkin di luar knowledge cutoff. Jika pencarian kosong, model tetap menjawab
  dari pengetahuannya.
- Setiap jawaban menampilkan tautan sumber yang dipakai.

## Menjalankan aplikasi

Persyaratan: Node.js 20.9 atau lebih baru.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Isi `.env.local` dengan kredensial asli:

```dotenv
TAVILY_API_KEY=tvly-...
REPLICATE_API_TOKEN=r8_...
REPLICATE_MODEL=google/gemini-2.5-flash
TWITCH_CLIENT_ID=...
TWITCH_CLIENT_SECRET=...
```

`REPLICATE_MODEL` opsional (default `google/gemini-2.5-flash`). Field input model
(`system_instruction`, `max_output_tokens`, `thinking_budget`) disetel untuk
Gemini di Replicate; ganti model hanya ke model dengan field serupa.
`TAVILY_API_KEY` juga opsional — tanpa itu, model menjawab dari pengetahuannya
sendiri tanpa sumber web.

### Autocomplete nama game (IGDB)

Autocomplete nama game memakai [IGDB](https://api-docs.igdb.com/), yang
diautentikasi lewat Twitch OAuth. Buat aplikasi di
[dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) untuk mendapat
`TWITCH_CLIENT_ID` dan `TWITCH_CLIENT_SECRET`. Kredensial ini **opsional**: tanpa
keduanya, field nama game tetap berfungsi sebagai input teks bebas (autocomplete
mati diam-diam). RAWG sempat dipertimbangkan tetapi kurang andal, jadi IGDB
dipakai sebagai sumber database game yang lebih lengkap.

Buka [http://localhost:3000](http://localhost:3000), isi nama game dan platform,
lalu ajukan pertanyaan dan tanyakan lanjutannya.

## Alur

1. Browser mengirim `{ game, platform, question, history }` ke `POST /api/solve`.
2. Route server merangkai kueri, lalu menjalankan pencarian berjenjang Tavily
   (`advanced`, best-effort), membersihkan snippet, memfilter berdasarkan skor
   relevansi, dan mengambil 3 sumber terkuat.
3. `system_instruction` (persona + aturan) dan `prompt` (game/platform, riwayat
   percakapan, dan bukti web) dikirim terpisah ke model Gemini di Replicate.
4. Browser menerima jawaban dan tautan sumber terpisah, lalu menambahkannya ke
   riwayat chat.

API key hanya digunakan di server dan tidak dikirim ke browser. Teks sumber dan
input game/platform diperlakukan sebagai data tidak tepercaya; model
diperintahkan untuk tidak mengikuti instruksi di dalamnya.

## Perintah

- `npm run dev` — development server
- `npm run build` — production build
- `npm start` — menjalankan production build
- `npm run check` — self-check kecil untuk prompt builder
