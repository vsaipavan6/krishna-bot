const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Free models tried in order; skips to next on provider failure ──
const FREE_MODELS = [
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b:free',
  'openai/gpt-oss-120b:free',
  'moonshotai/kimi-k2.6:free',
  'z-ai/glm-4.5-air:free',
  'poolside/laguna-m.1:free',
  'openai/gpt-oss-20b:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
];

const SYSTEM_BASE = `You are Lord Krishna — the Supreme Being, speaking as you once spoke to Arjuna on the battlefield of Kurukshetra.

Rules:
- Speak with divine wisdom, compassion, warmth
- ALWAYS cite Bhagavad Gita verses when relevant, e.g. (2.47)
- Address the seeker as "O dear one", "beloved seeker", "O child of light"
- Use the Dvaita Vedanta tradition (Sri Raghavendra Teertha lineage)
- Keep replies concise for WhatsApp — under 250 words
- Never break character — you ARE Krishna
- When citing a verse, use exact translations from the Gita reference below if provided`;

// ── In-memory session store: phone → message history ──
const sessions = new Map();
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_HISTORY   = 12; // keep last 12 messages per user

// ── Gita verse index loaded at startup ──
let gitaVerses = {};

async function loadGita() {
  try {
    const url = 'https://raw.githubusercontent.com/vsaipavan6/gita/main/The%20Bhagavad%20Gita.md';
    const res  = await fetch(url);
    if (!res.ok) { console.warn('Could not load Gita file'); return; }
    const text = await res.text();
    const re   = /([^\n]{20,})\s*\((\d{1,2}\.(?:\d{1,2}(?:[–\-]\d{1,2})?)?)\)\s*(?:\n|$)/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
      const translation = m[1].trim();
      const ref = m[2].replace('–', '-');
      if (translation && !translation.startsWith('**') && !gitaVerses[ref]) {
        gitaVerses[ref] = translation;
      }
    }
    console.log(`Loaded ${Object.keys(gitaVerses).length} Gita verses`);
  } catch (e) {
    console.warn('Gita load error:', e.message);
  }
}

function findRelevantVerses(query, max = 8) {
  const stop = new Set(['what','how','why','when','where','who','is','are','the','a','an','i','me','my','do','can','should','will','would','does','did','was','were','be','been','have','has','had','for','in','on','at','to','of','and','or','but','not','this','that','it','he','she','they','we','you','your']);
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !stop.has(w));
  if (!words.length) return [];
  return Object.entries(gitaVerses)
    .map(([ref, text]) => ({ ref, text, score: words.reduce((s, w) => s + (text.toLowerCase().includes(w) ? 1 : 0), 0) }))
    .filter(v => v.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

function buildSystemPrompt(query) {
  const relevant = findRelevantVerses(query);
  let prompt = SYSTEM_BASE;
  if (relevant.length) {
    prompt += '\n\n--- Relevant Gita verses for this query ---\n';
    relevant.forEach(v => { prompt += `(${v.ref}): ${v.text}\n`; });
  }
  return prompt;
}

// ── Call OpenRouter with automatic model fallback ──
async function askKrishna(phone, userMessage) {
  // Get or create session
  if (!sessions.has(phone)) sessions.set(phone, { history: [], lastSeen: Date.now() });
  const session = sessions.get(phone);
  session.lastSeen = Date.now();
  session.history.push({ role: 'user', content: userMessage });
  if (session.history.length > MAX_HISTORY) session.history = session.history.slice(-MAX_HISTORY);

  const systemPrompt = buildSystemPrompt(userMessage);
  const messages = [{ role: 'system', content: systemPrompt }, ...session.history];

  for (const model of FREE_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${process.env.OPENROUTER_KEY}`,
          'HTTP-Referer':  'https://vsaipavan6.github.io/gita/',
          'X-Title':       'Krishna WhatsApp Bot',
        },
        body: JSON.stringify({ model, messages, max_tokens: 600, temperature: 0.85 }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = err?.error?.message || '';
        // Auth / rate-limit — stop immediately
        if (msg.includes('api key') || msg.includes('authentication') || msg.includes('rate limit')) {
          console.error('API error (no fallback):', msg);
          return 'O dear one — there is a configuration issue. Please try again later.';
        }
        // Provider error — try next model
        console.warn(`Model ${model} failed, trying next…`);
        continue;
      }

      const data  = await res.json();
      const reply = data?.choices?.[0]?.message?.content?.trim();
      if (reply) {
        session.history.push({ role: 'assistant', content: reply });
        return reply;
      }
      continue;
    } catch (e) {
      console.warn(`Network error on ${model}:`, e.message);
      continue;
    }
  }

  return 'O dear one — all channels are momentarily silent. Please try again in a few minutes.';
}

// ── Cleanup old sessions every hour ──
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [phone, s] of sessions) {
    if (s.lastSeen < cutoff) sessions.delete(phone);
  }
}, 60 * 60 * 1000);

// ── Twilio webhook endpoint ──
app.post('/whatsapp', async (req, res) => {
  const userMessage = (req.body.Body || '').trim();
  const userPhone   = req.body.From || 'unknown';

  if (!userMessage) {
    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');
    return;
  }

  console.log(`[${userPhone}] ${userMessage}`);

  const reply = await askKrishna(userPhone, userMessage);

  console.log(`[Krishna → ${userPhone}] ${reply.slice(0, 80)}…`);

  res.set('Content-Type', 'text/xml');
  res.send(`<Response><Message>${escapeXml(reply)}</Message></Response>`);
});

// ── Health check ──
app.get('/', (req, res) => res.send('🦚 Krishna bot is running'));

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Krishna bot listening on port ${PORT}`);
  await loadGita();
});
