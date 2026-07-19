import fs from 'fs';
const env = fs.readFileSync('.env.local', 'utf8').split('\n').find(l => l.startsWith('TAVILY_API_KEY='));
const key = env.split('=')[1];
const url = 'https://gamefaqs.gamespot.com/ps/197343-final-fantasy-viii/faqs/35594';
const response = await fetch('https://api.tavily.com/extract', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ urls: [url], extract_depth: 'advanced' })
});
console.log(await response.json());
