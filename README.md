# GameGuide Guru

Prototipe companion game mobile-first yang mencari walkthrough di web dengan
Tavily, lalu merangkum langkah yang relevan menggunakan model AI di Replicate.

## Fitur

- Field nama game dan selector platform (dari era NES sampai Switch 2, PS5, Xbox
  Series, PC, dan lainnya) untuk mempertajam pencarian.
- Chat lanjutan multi-turn: konteks hingga 5 percakapan terakhir dikirim ke
  model sehingga pertanyaan lanjutan seperti "lalu setelah bos itu ke mana?"
  tetap dipahami.
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
REPLICATE_MODEL=meta/meta-llama-3-8b-instruct
```

`REPLICATE_MODEL` opsional dan dapat diganti dengan model publik Replicate lain
dalam format `owner/name`.

Buka [http://localhost:3000](http://localhost:3000), isi nama game dan platform,
lalu ajukan pertanyaan dan tanyakan lanjutannya.

## Alur

1. Browser mengirim `{ game, platform, question, history }` ke `POST /api/solve`.
2. Route server merangkai kueri dari game + platform + pertanyaan, lalu mencari
   hingga lima sumber melalui Tavily.
3. Cuplikan hasil pencarian, konteks game/platform, dan riwayat percakapan
   (maksimal 5 turn terakhir) dikirim ke Replicate.
4. Browser menerima ringkasan dan tautan sumber terpisah, lalu menambahkannya ke
   riwayat chat.

API key hanya digunakan di server dan tidak dikirim ke browser. Teks sumber
diperlakukan sebagai input tidak tepercaya; model diperintahkan untuk tidak
mengikuti instruksi dari cuplikan web.

## Perintah

- `npm run dev` — development server
- `npm run build` — production build
- `npm start` — menjalankan production build
- `npm run check` — self-check kecil untuk prompt builder
