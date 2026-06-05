const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ─────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Handle large PDF payloads

// ── HEALTH CHECK ───────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'GMRG API running', version: '1.0.0' });
});

// ── ANTHROPIC PROXY ────────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
    }

    const client = new Anthropic({ apiKey });

    const { model, max_tokens, messages, system } = req.body;

    if (!model || !max_tokens || !messages) {
      return res.status(400).json({ error: 'Missing required fields: model, max_tokens, messages' });
    }

    const params = { model, max_tokens, messages };
    if (system) params.system = system;

    console.log(`[Claude] model=${model} max_tokens=${max_tokens} messages=${messages.length}`);

    const response = await client.messages.create(params);

    console.log(`[Claude] done — stop_reason=${response.stop_reason} tokens=${response.usage?.output_tokens}`);

    res.json(response);

  } catch (err) {
    console.error('[Claude] Error:', err.message);
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

// ── START ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`GMRG API server running on port ${PORT}`);
});
