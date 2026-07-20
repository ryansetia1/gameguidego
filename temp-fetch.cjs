const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const envFile = fs.readFileSync('.env.local', 'utf8');
let supabaseUrl, supabaseKey;

envFile.split('\n').forEach(line => {
  if (line.startsWith('NEXT_PUBLIC_SUPABASE_URL=')) {
    supabaseUrl = line.split('=')[1].trim();
  } else if (line.startsWith('SUPABASE_SERVICE_ROLE_KEY=')) {
    supabaseKey = line.split('=')[1].trim();
  }
});

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const { data, error } = await supabase
    .from('trace_events')
    .select('event_type, message, metadata, created_at')
    .eq('trace_id', 'f7b52570-a453-4b55-9faa-c1a979d45ab6')
    .order('created_at', { ascending: true });

  if (error) {
    console.error(error);
  } else {
    fs.writeFileSync('hk-trace4.json', JSON.stringify(data, null, 2));
  }
}

main();
