# Embedding Model Registry

Dokumen ini mencatat semua model embedding yang pernah/sedang digunakan di pipeline
RAG GameGuide Go, beserta spesifikasi teknis dan cara implementasinya. Gunakan
sebagai referensi saat ingin mengganti atau menambah model embedding baru.

---

## Model yang Aktif

### text-embedding-3-large (Sumopod)

| Spec | Value |
|------|-------|
| Provider | Sumopod (OpenAI-compatible API) |
| Model name | `text-embedding-3-large` |
| SDK | `openai` npm package |
| Base URL | `https://ai.sumopod.com/v1` |
| Max tokens | 8.191 |
| Native dimensions | 3.072 (dikurangi ke 1.024 via parameter `dimensions`) |
| Output dimensions (aktif) | 1.024 |
| Instruction prefix | ❌ Tidak diperlukan (plug-and-play, symmetric) |
| Batching | Hingga 2.048 inputs per call (SDK handle internal) |
| Retry | Built-in `maxRetries` di OpenAI SDK |
| Aktif sejak | Juli 2026 |

**Env vars:**
```
SUMOPOD_API_KEY=your-key
SUMOPOD_BASE_URL=https://ai.sumopod.com/v1
# Optional override:
# EMBED_MODEL=text-embedding-3-large
```

**Cara pemanggilan API (di `lib/embed.ts`):**
```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.SUMOPOD_API_KEY,
  baseURL: process.env.SUMOPOD_BASE_URL || "https://ai.sumopod.com/v1",
  maxRetries: 3,
  timeout: 120_000,
});

const response = await client.embeddings.create({
  model: "text-embedding-3-large",
  input: texts,       // string atau string[]
  dimensions: 1024,   // native dimension reduction
});

// Output: response.data[i].embedding → number[]
```

**Catatan:**
- Model ini bersifat symmetric: query dan document di-embed tanpa instruksi apapun.
- Tidak memerlukan `instruction` parameter.
- `dimensions: 1024` wajib disertakan agar selaras dengan schema pgvector `vector(1024)`.

---

## Model Sebelumnya (Nonaktif)

### Qwen3-Embedding-8B (Replicate)

| Spec | Value |
|------|-------|
| Provider | Replicate |
| Model name | `lucataco/qwen3-embedding-8b` |
| Version | `42d968487820032a1535d81ea20df16f442ea308ec5abae6b5d6cf4675eb3e2f` |
| SDK | `replicate` npm package |
| Max tokens | ~8.000 (estimasi; tidak dipublikasikan secara resmi) |
| Native dimensions | 4.096 |
| Output dimensions (dipakai) | 1.024 (via `embedding_dim` parameter) |
| Instruction prefix | ✅ Didukung (asymmetric) tapi **sengaja di-OFF-kan** |
| Batching | Manual, max 32 per call (`batch_size` parameter) |
| Retry | Custom `withReplicateRetry` (string-matching pada error 429) |
| Aktif | Sebelum Juli 2026 |
| Alasan diganti | Decoupling dari Replicate, simplifikasi (no instruction alignment issue), standar industri OpenAI SDK |

**Env vars (saat aktif):**
```
REPLICATE_API_TOKEN=r8_your-token       # Shared dengan Gemini LLM
# Optional:
# EMBED_MODEL=lucataco/qwen3-embedding-8b:42d96848...
# EMBED_QUERY_INSTRUCTION=Given a video game player's question, retrieve the walkthrough guide passages that answer it.
# EMBED_CONCURRENCY=5
# EMBED_BATCH_DELAY_MS=150
```

**Cara pemanggilan API (implementasi lama di `lib/embed.ts`):**
```ts
import Replicate from "replicate";

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

const output = await replicate.run(
  "lucataco/qwen3-embedding-8b:42d96848...",
  {
    input: {
      text: texts,            // string atau string[]
      embedding_dim: 1024,
      normalize: true,
      batch_size: 32,
      // instruction: "...",  // Opsional, sengaja di-OFF-kan
    },
  },
);

// Output: output.embeddings[i] → number[]
```

**Catatan penting jika ingin kembali ke Qwen3:**
- Qwen3 mendukung asymmetric instruction (`instruction` parameter) untuk query
  embedding, TAPI dokumen di-embed TANPA instruction. Mengaktifkan instruction
  pada query tanpa recalibrate `GUIDE_HIT` threshold akan menggeser query vector
  keluar dari alignment dengan document vectors → retrieval jadi buruk.
- Kalau kembali ke Qwen3, pastikan `EMBED_QUERY_INSTRUCTION` tetap kosong (OFF)
  kecuali sudah dilakukan kalibrasi ulang terhadap `GUIDE_HIT`.
- Retry logic Replicate menggunakan string-matching pada error message (`"429"`,
  `"rate limit"`, `"throttl"`, dll.) di `lib/replicate-retry.js`.

---

## Cara Mengganti Model Embedding

### Checklist migrasi

1. **Ubah `lib/embed.ts`** — Ini satu-satunya file yang berisi logika pemanggilan
   API embedding. Ganti SDK, parsing output, dan singleton client.

2. **Update `lib/embed-cache.ts`** — Pastikan `MODEL_TAG` default sesuai model
   baru. Tag ini namespace-kan cache agar vector dari model berbeda tidak tercampur.

3. **Update `lib/embed-log.ts`** — Ganti fallback model name di
   `resolveEmbedModel()`.

4. **Update `lib/guide-ingest.ts`** — Ganti guard condition di
   `isGuideRagAvailable()` dan fungsi ingest agar mengecek env var yang benar
   (e.g. `REPLICATE_API_TOKEN` vs `SUMOPOD_API_KEY`).

5. **Update `.env.local` + `.env.example`** — Tambah/hapus env vars sesuai
   provider.

6. **Flush `guide_chunks`** — Vectors dari model lama TIDAK kompatibel dengan
   model baru (cosine similarity cross-model = sampah). Backup dulu, lalu truncate:
   ```sql
   CREATE TABLE guide_chunks_backup_<model> AS SELECT * FROM guide_chunks;
   TRUNCATE guide_chunks;
   ```
   Pipeline lazy re-ingest akan mengisi ulang saat user chat.

7. **`embed_cache`** — JANGAN truncate. `MODEL_TAG` namespace sudah memisahkan
   cache per model secara otomatis. Rows model lama = gratis rollback cache.

8. **Kalibrasi `GUIDE_HIT`** — Threshold cosine similarity di `lib/guide-rag.ts`
   (default `0.35`) di-tune per model. Aktifkan `RAG_DEBUG=1` dan monitor output
   `[rag-calibrate]` di console. Prosedur lengkap + rekomendasi chunk/K/reranker:
   [plan/rag-tuning-roadmap.md](./plan/rag-tuning-roadmap.md).

9. **Update `CLAUDE.md`** — Dokumentasi harus selalu selaras dengan kode aktif.

### File yang TIDAK perlu diubah saat ganti model

| File | Alasan |
|------|--------|
| `lib/chunk-guide.js` | Pure text splitting, model-agnostic |
| `lib/guide-rag.ts` | Hanya perlu tune `GUIDE_HIT` constant, bukan code change |
| `db/guide-chunks.sql` | Selama output tetap `vector(1024)` |
| `db/embed-cache.sql` | Selama output tetap `vector(1024)` |
| `app/api/solve/route.ts` | Interface `retrieveFromPreferredGuides` tidak berubah |
| `app/api/guide-ingest/route.ts` | Interface `ensureGuideIngested` tidak berubah |

### Jika dimensi output berubah (bukan 1024)

Perlu ALTER pgvector columns:
```sql
-- Backup dulu
CREATE TABLE guide_chunks_backup AS SELECT * FROM guide_chunks;
CREATE TABLE embed_cache_backup AS SELECT * FROM embed_cache;

-- Ubah dimensi (contoh: 768)
ALTER TABLE guide_chunks ALTER COLUMN embedding TYPE vector(768);
ALTER TABLE embed_cache ALTER COLUMN embedding TYPE vector(768);

-- Update RPC function
CREATE OR REPLACE FUNCTION public.match_guide_chunks(
  p_guide_urls text[],
  p_guide_bundles text[],
  p_embedding vector(768),    -- sesuaikan
  p_limit int default 5
) ...

-- Update EMBEDDING_DIM di lib/embed.ts
const EMBED_DIM = 768;
```
