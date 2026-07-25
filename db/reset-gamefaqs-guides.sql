-- Dev reset: wipe legacy GameFAQs bundle ingest rows before print=1-only re-ingest.
DELETE FROM guide_chunks
WHERE guide_url LIKE '%gamefaqs.gamespot.com%'
   OR guide_bundle IS NOT NULL;

DELETE FROM guide_bundle_cache;
