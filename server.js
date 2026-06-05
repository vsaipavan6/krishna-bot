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
const sessions    = new Map();
const SESSION_TTL = 2 * 60 * 60 * 1000; // 2 hours
const MAX_HISTORY = 12;

// ── Gita verse index loaded at startup ──
let gitaVerses = {};

async function loadGita() {
  try {
    const res  = await fetch('https://raw.githubusercontent.com/vsaipavan6/gita/main/The%20Bhagavad%20Gita.md');
    if (!res.ok) { console.warn('Could not load Gita file'); return; }
    const text = await res.text();
    const re   = /([^\n]{20,})\s*\((\d{1,2}\.(?:\d{1,2}(?:[–\-]\d{1,2})?)?)\)\s*(?:\n|$)/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
      const t = m[1].trim(), ref = m[2].replace('–', '-');
      if (t && !t.startsWith('**') && !gitaVerses[ref]) gitaVerses[ref] = t;
    }
    console.log(`Loaded ${Object.keys(gitaVerses).length} Gita verses`);
  } catch (e) { console.warn('Gita load error:', e.message); }
}

function findRelevantVerses(query, max = 8) {
  const stop = new Set(['what','how','why','when','where','who','is','are','the','a','an','i','me','my','do','can','should','will','would','does','did','was','were','be','been','have','has','had','for','in','on','at','to','of','and','or','but','not','this','that','it','he','she','they','we','you','your']);
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !stop.has(w));
  if (!words.length) return [];
  return Object.entries(gitaVerses)
    .map(([ref, text]) => ({ ref, text, score: words.reduce((s, w) => s + (text.toLowerCase().includes(w) ? 1 : 0), 0) }))
    .filter(v => v.score > 0).sort((a, b) => b.score - a.score).slice(0, max);
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

// ── Core: call OpenRouter with automatic model fallback ──
async function askKrishna(phone, userMessage) {
  if (!sessions.has(phone)) sessions.set(phone, { history: [], lastSeen: Date.now() });
  const session = sessions.get(phone);
  session.lastSeen = Date.now();
  session.history.push({ role: 'user', content: userMessage });
  if (session.history.length > MAX_HISTORY) session.history = session.history.slice(-MAX_HISTORY);

  const messages = [{ role: 'system', content: buildSystemPrompt(userMessage) }, ...session.history];

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
        if (msg.includes('api key') || msg.includes('authentication') || msg.includes('rate limit')) {
          console.error('API auth error:', msg);
          return 'O dear one — there is a configuration issue. Please try again later.';
        }
        console.warn(`Model ${model} failed, trying next…`);
        continue;
      }
      const reply = (await res.json())?.choices?.[0]?.message?.content?.trim();
      if (reply) { session.history.push({ role: 'assistant', content: reply }); return reply; }
    } catch (e) { console.warn(`Network error on ${model}:`, e.message); }
  }
  return 'O dear one — all channels are momentarily silent. Please try again in a few minutes.';
}

// ── Cleanup old sessions every hour ──
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL;
  for (const [p, s] of sessions) if (s.lastSeen < cutoff) sessions.delete(p);
}, 60 * 60 * 1000);

// ════════════════════════════════════════════════════
// TWILIO — /whatsapp
// ════════════════════════════════════════════════════
app.post('/whatsapp', async (req, res) => {
  const msg   = (req.body.Body || '').trim();
  const phone = req.body.From || 'unknown';
  if (!msg) { res.set('Content-Type','text/xml'); res.send('<Response></Response>'); return; }
  console.log(`[Twilio][${phone}] ${msg}`);
  const reply = await askKrishna(phone, msg);
  console.log(`[Twilio→${phone}] ${reply.slice(0,80)}…`);
  res.set('Content-Type', 'text/xml');
  res.send(`<Response><Message>${escXml(reply)}</Message></Response>`);
});

// ════════════════════════════════════════════════════
// META — /meta-webhook
// ════════════════════════════════════════════════════

// Step 1: Meta calls GET to verify the webhook
app.get('/meta-webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('Meta webhook verified ✅');
    res.status(200).send(challenge);
  } else {
    console.warn('Meta webhook verification failed — token mismatch');
    res.sendStatus(403);
  }
});

// Step 2: Meta sends incoming messages as POST
app.post('/meta-webhook', async (req, res) => {
  res.sendStatus(200); // acknowledge immediately so Meta doesn't retry

  try {
    const entry   = req.body?.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const messages = changes?.messages;
    if (!messages?.length) return;

    const msg       = messages[0];
    const phone     = msg.from;           // e.g. "919390263955"
    const text      = msg?.text?.body;
    const phoneNumId = changes?.metadata?.phone_number_id;

    if (!text || !phoneNumId) return;

    console.log(`[Meta][+${phone}] ${text}`);

    const reply = await askKrishna(`meta:${phone}`, text);

    console.log(`[Meta→+${phone}] ${reply.slice(0,80)}…`);

    // Send reply back via Meta Graph API
    const sendRes = await fetch(`https://graph.facebook.com/v19.0/${phoneNumId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: reply },
      }),
    });
    if (!sendRes.ok) {
      const errBody = await sendRes.json().catch(() => ({}));
      const errMsg  = errBody?.error?.message || sendRes.status;
      if (String(errMsg).includes('Session has expired') || String(errMsg).includes('access token')) {
        console.error('🔴 META TOKEN EXPIRED — go to developers.facebook.com and regenerate the access token, then update META_ACCESS_TOKEN on Railway.');
      } else {
        console.error(`Meta send failed [${sendRes.status}]:`, errMsg);
      }
    }
  } catch (e) {
    console.error('Meta webhook error:', e.message);
  }
});

// ── Health check ──
app.get('/', (req, res) => res.send('🦚 Krishna bot is running (Twilio + Meta)'));

function escXml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Krishna bot listening on port ${PORT}`);
  await loadGita();
});
