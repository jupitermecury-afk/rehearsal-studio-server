const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.options('*', cors());
app.use(express.json());

app.post('/anticipate', async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  console.log('Key present:', !!key);
  console.log('Key starts with:', key ? key.substring(0,12) : 'MISSING');
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    console.log('Anthropic status:', response.status);
    res.json(data);
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

app.get('/health', (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  res.json({ 
    status: 'ok',
    key_present: !!key,
    key_prefix: key ? key.substring(0,12) : 'MISSING'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rehearsal Studio server running on port ${PORT}`));
