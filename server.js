const express = require('express');
const cors    = require('cors');


const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ── REHEARSAL STUDIO ────────────────────────────────────────────────────────
// Locked down: the client sends only { key, grade, topic, messages }.
// Model, max_tokens and the system prompt are fixed here so the relay cannot
// be used as a general-purpose Claude endpoint.
app.set('trust proxy', 1);

const REHEARSAL_MODEL      = 'claude-sonnet-4-5';
const REHEARSAL_MAX_TOKENS = 1800;
const MAX_MESSAGES         = 14;     // 5 turns = at most 9 messages
const MAX_TOTAL_CHARS      = 40000;
const PER_IP_LIMIT         = Number(process.env.REHEARSAL_PER_IP_LIMIT || 120);    // per 10 min
const GLOBAL_HOURLY_LIMIT  = Number(process.env.REHEARSAL_GLOBAL_HOURLY_LIMIT || 1500);

// Same keys/windows as the page (UTC, inclusive). Add new cohorts here too.
const ACCESS_KEYS = [
  { key: 'REHEARSE-NOV-2026', validFrom: '2026-11-04', validTo: '2026-11-09' },
  { key: 'PRESENTER-TEST',    validFrom: '2026-11-01', validTo: '2026-11-03' },
];

function keyIsValid(input) {
  const k = String(input || '').trim().toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  return ACCESS_KEYS.some(e => e.key === k && today >= e.validFrom && today <= e.validTo);
}

const ipHits = new Map();   // ip -> [timestamps]
let globalHits = [];
function rateLimited(ip) {
  const now = Date.now();
  const recent = (ipHits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  globalHits = globalHits.filter(t => now - t < 60 * 60 * 1000);
  if (recent.length >= PER_IP_LIMIT || globalHits.length >= GLOBAL_HOURLY_LIMIT) {
    ipHits.set(ip, recent);
    return true;
  }
  recent.push(now); globalHits.push(now);
  ipHits.set(ip, recent);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of ipHits) if (!ts.some(t => now - t < 10 * 60 * 1000)) ipHits.delete(ip);
}, 10 * 60 * 1000).unref();

function rehearsalSystem(grade, topic) {
  return `You are running a deliberate practice session for mathematics teachers grounded in NCTM's Principles to Actions (2014), specifically Practice 5: Pose Purposeful Questions.

THE TEACHER is practicing live in a ${grade} classroom in North Carolina on the topic of ${topic}.

THE THREE STUDENTS YOU SIMULATE:
- Darius: computationally confident, often correct but struggles to explain reasoning. He tends to shut down when pressed too hard. He will not open up easily and gives minimal responses unless the teacher's question genuinely invites him.
- Leila: an English learner who reasons visually and draws diagrams. She understands more than she can verbalize in English and waits to be called on rather than volunteering. Do not have her suddenly become verbal — she responds to targeted, low-pressure invitations.
- Marcus: verbally dominant, socially influential. His reasoning is often partially correct but he speaks with confidence that discourages peers from disagreeing. He does not back down without evidence.

SESSION STRUCTURE — 1 ARC, 5 TURNS:
Turn 1: Open — present the problem and students' initial responses. Ask the teacher what question they pose and to whom.
Turn 2: Develop — a student says something that requires a teacher move. One decision point only.
Turn 3: Develop — a second decision point, increasing complexity.
Turn 4: Develop — introduce one complication: if teacher scored 3-4 on mathematical advancement two turns in a row, Darius shuts down OR Leila's diagram contradicts Marcus's claim OR Marcus pressures a peer. If teacher scored 1-2, simplify.
Turn 5: CLOSING OPPORTUNITY — signal that the mathematical idea is now in the room. Ask teacher to make the closing move.

AT EACH TURN return ONLY valid JSON:
{
  "turn": number 1-5,
  "scene": "1-2 sentence present-tense description of exactly what is happening right now",
  "students": [
    {"name":"Darius","text":"what Darius says or does — authentic to his profile","av":"d"},
    {"name":"Leila","text":"what Leila says or does — authentic to her profile","av":"l"},
    {"name":"Marcus","text":"what Marcus says or does — authentic to his profile","av":"m"}
  ],
  "input_prompt": "the specific question to the teacher for this turn — Turn 5 should signal the closing opportunity explicitly",
  "is_closing": false,
  "feedback": null,
  "arc_debrief": null
}

When the TEACHER has responded (turns 2-5), evaluate their move and return:
{
  "turn": number,
  "scene": "what happens next in the classroom as a result of the teacher's move",
  "students": [...student reactions based on teacher's move...],
  "input_prompt": "next question to teacher",
  "is_closing": false,
  "feedback": {
    "question_type": "gathering|probing|making connections|funneling",
    "scores": {
      "mathematical_advancement": "strong|developing|missed",
      "student_agency": "strong|developing|missed",
      "equity_of_access": "strong|developing|missed"
    },
    "observation": "2 sentences — specific evidence from what the teacher said",
    "alternative": "one specific alternative question the teacher could have asked"
  },
  "arc_debrief": null
}

After Turn 5 teacher response, return the arc debrief:
{
  "turn": 5,
  "scene": "final classroom moment",
  "students": [...],
  "input_prompt": null,
  "is_closing": true,
  "feedback": {...turn 5 feedback...},
  "arc_debrief": {
    "pattern": "one pattern noticed across all 5 teacher moves",
    "strength": "one specific strength with evidence",
    "focus": "one specific focus for next rehearsal — name the exact moment to rehearse, not the abstract practice"
  }
}

HARD CONSTRAINTS:
- Never model what a good question sounds like before the teacher responds.
- Never resolve the mathematical confusion before the teacher has addressed it.
- Never have students understand something the teacher has not helped them work toward.
- One decision point per turn — never present the next until teacher has responded.
- Student reactions must match their character profiles. Hold to those profiles always.
- Do not label the teacher's question type before they respond.
- Base all mathematics on realistic NC curriculum for the grade and topic specified.`;
}

const SCORE = { type: 'string', enum: ['strong', 'developing', 'missed'] };
const TURN_TOOL = {
  name: 'classroom_turn',
  description: 'Return this turn of the classroom simulation.',
  input_schema: {
    type: 'object',
    properties: {
      turn:  { type: 'integer' },
      scene: { type: 'string' },
      students: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            text: { type: 'string' },
            av:   { type: 'string', enum: ['d', 'l', 'm'] }
          },
          required: ['name', 'text', 'av']
        }
      },
      input_prompt: { type: ['string', 'null'] },
      is_closing:   { type: 'boolean' },
      feedback: {
        type: ['object', 'null'],
        properties: {
          question_type: { type: 'string' },
          scores: {
            type: 'object',
            properties: {
              mathematical_advancement: SCORE,
              student_agency:           SCORE,
              equity_of_access:         SCORE
            }
          },
          observation: { type: 'string' },
          alternative: { type: 'string' }
        }
      },
      arc_debrief: {
        type: ['object', 'null'],
        properties: {
          pattern:  { type: 'string' },
          strength: { type: 'string' },
          focus:    { type: 'string' }
        }
      }
    },
    required: ['turn', 'scene', 'students', 'input_prompt', 'is_closing']
  }
};

app.post('/anticipate', async (req, res) => {
  const { key, grade, topic, messages } = req.body || {};

  if (!keyIsValid(key)) {
    return res.status(401).json({ error: { message: 'Access key is not valid right now.' } });
  }
  if (typeof grade !== 'string' || typeof topic !== 'string' ||
      !grade.trim() || !topic.trim() || grade.length > 60 || topic.length > 200) {
    return res.status(400).json({ error: { message: 'Invalid grade or topic.' } });
  }
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES ||
      !messages.every(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') ||
      messages.reduce((n, m) => n + m.content.length, 0) > MAX_TOTAL_CHARS) {
    return res.status(400).json({ error: { message: 'Invalid messages.' } });
  }
  if (rateLimited(req.ip)) {
    return res.status(429).json({ error: { message: 'The studio is busy right now. Please wait a minute and try again.' } });
  }

  try {
    const body = JSON.stringify({
      model:      REHEARSAL_MODEL,
      max_tokens: REHEARSAL_MAX_TOKENS,
      system:     rehearsalSystem(grade.trim(), topic.trim()),
      messages:   messages.map(m => ({ role: m.role, content: m.content })),
      tools:       [TURN_TOOL],
      tool_choice: { type: 'tool', name: TURN_TOOL.name }
    });

    // The model sometimes returns malformed JSON. Validate here and retry so
    // clients only ever receive a reply they can parse.
    let lastRaw = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         process.env.TEST_KEY,
          'anthropic-version': '2023-06-01'
        },
        body
      });
      const data = await response.json();
      if (!response.ok) return res.status(response.status).json(data);

      const toolBlock = (data.content || []).find(b => b.type === 'tool_use');
      const raw = toolBlock
        ? JSON.stringify(toolBlock.input)
        : (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      try {
        const parsed = toolBlock
          ? toolBlock.input
          : JSON.parse(raw.replace(/```json|```/g, '').trim());
        if (parsed && typeof parsed.scene === 'string' && Array.isArray(parsed.students)) {
          data.content = [{ type: 'text', text: JSON.stringify(parsed) }];
          return res.json(data);
        }
        throw new Error('missing scene/students');
      } catch (e) {
        lastRaw = raw;
        console.error(`[Rehearsal] bad model JSON (attempt ${attempt}, stop=${data.stop_reason}): ${e.message}
${raw.slice(0, 3000)}`);
      }
    }
    res.status(502).json({ error: { message: 'The classroom had a hiccup. Please press Respond again.' } });
  } catch (err) {
    console.error('[Rehearsal] error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── TAVILY SEARCH HELPER ─────────────────────────────────────────────────────
async function tavilySearch(query) {
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key:        process.env.TAVILY_API_KEY,
        query:          query,
        search_depth:   'basic',
        max_results:    5,
        include_answer: true
      })
    });
    const data = await response.json();
    return data;
  } catch (err) {
    console.error('[Tavily] error:', err);
    return null;
  }
}

// ── COUNTERPART ──────────────────────────────────────────────────────────────
app.post('/counterpart', async (req, res) => {
  const { model, max_tokens, system, messages, key_name } = req.body;
  console.log(`[Counterpart] key=${key_name || 'unknown'} messages=${messages?.length}`);

  try {
    // ── STEP 1: Ask Claude whether a search is needed ──────────────────────
    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
    const searchCheckMessages = [
      {
        role: 'user',
        content: `Given this message from a person seeking help, does answering it well require current, real-world information that may have changed recently — such as current prices, fees, phone numbers, office addresses, government requirements, exchange rates, company policies, or recent news?\n\nMessage: "${lastUserMessage?.content}"\n\nRespond with ONLY a JSON object in this exact format:\n{"needs_search": true, "query": "the search query to run"}\nor\n{"needs_search": false, "query": null}`
      }
    ];

    const checkResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.TEST_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      model,
        max_tokens: 200,
        messages:   searchCheckMessages
      })
    });

    const checkData  = await checkResponse.json();
    const checkText  = checkData.content?.find(b => b.type === 'text')?.text || '{}';
    let   searchResult = null;
    let   searchQuery  = null;

    try {
      const cleaned = checkText.replace(/```json|```/g, '').trim();
      const parsed  = JSON.parse(cleaned);
      if (parsed.needs_search && parsed.query) {
        searchQuery  = parsed.query;
        console.log(`[Counterpart] searching: "${searchQuery}"`);
        searchResult = await tavilySearch(searchQuery);
      }
    } catch (e) {
      // Search check failed to parse — proceed without search
    }

    // ── STEP 2: Build the final system prompt ─────────────────────────────
    let finalSystem = system;

    if (searchResult) {
      const answer  = searchResult.answer || '';
      const sources = (searchResult.results || [])
        .slice(0, 4)
        .map(r => `- ${r.title}: ${r.content?.slice(0, 200)}... (${r.url})`)
        .join('\n');

      const searchContext = `
LIVE SEARCH RESULTS — retrieved now for this conversation:
Search query: "${searchQuery}"
${answer ? `Summary: ${answer}` : ''}
Sources:
${sources}

Use this information naturally in your response. Do not announce that you searched unless the person specifically asks how you know something or asks you to show your sources — in that case, share the sources listed above. Weave the information in as if you simply know it.`;

      finalSystem = system + '\n\n' + searchContext;
    }

    // ── STEP 3: Call Claude with full context ─────────────────────────────
    const finalResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.TEST_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model, max_tokens, system: finalSystem, messages })
    });

    const finalData = await finalResponse.json();
    res.json(finalData);

  } catch (err) {
    console.error('[Counterpart] error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
