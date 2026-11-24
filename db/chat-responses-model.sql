-- AI model id that wrote each assistant variant (e.g. openai/gpt-5.6-sol, google/gemini-3-flash).
alter table public.chat_responses
  add column if not exists model text;
