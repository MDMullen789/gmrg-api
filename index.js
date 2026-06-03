const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.get('/', (req, res) => { res.json({ status: 'GMRG API running', version: '2.1.0' }); });
app.post('/api/claude', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    const client = new Anthropic({ apiKey });
    const { model, max_tokens, messages, system } = req.body;
    if (!model || !max_tokens || !messages) return res.status(400).json({ error: 'Missing required fields' });
    const params = { model, max_tokens, messages };
    if (system) params.system = system;
    console.log(`[Claude] model=${model} max_tokens=${max_tokens}`);
    const response = await client.messages.create(params);
    console.log(`[Claude] done stop_reason=${response.stop_reason} tokens=${response.usage?.output_tokens}`);
    res.json(response);
  } catch (err) {
    console.error('[Claude] Error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});
app.post('/api/publish', async (req, res) => {
  try {
    const netlifyToken = process.env.NETLIFY_TOKEN;
    if (!netlifyToken) return res.status(500).json({ error: 'NETLIFY_TOKEN not configured' });
    const { html } = req.body;
    if (!html) return res.status(400).json({ error: 'Missing html' });
    const SITE_ID = 'd347dd58-9399-40bb-beb7-673190bc3226';
    const htmlBuffer = Buffer.from(html, 'utf8');
    const sha1 = crypto.createHash('sha1').update(htmlBuffer).digest('hex');
    console.log('[Publish] Creating deploy on gmrglibrary...');
    const deployRes = await fetch(`https://api.netlify.com/api/v1/sites/${SITE_ID}/deploys`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${netlifyToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: { '/index.html': sha1 } })
    });
    if (!deployRes.ok) throw new Error('Deploy failed: ' + (await deployRes.text()).slice(0, 300));
    const deploy = await deployRes.json();
    console.log('[Publish] Deploy created: ' + deploy.id);
    const uploadRes = await fetch(`https://api.netlify.com/api/v1/deploys/${deploy.id}/files/index.html`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${netlifyToken}`, 'Content-Type': 'application/octet-stream' },
      body: htmlBuffer
    });
    if (!uploadRes.ok) throw new Error('Upload failed: ' + (await uploadRes.text()).slice(0, 300));
    const deployUrl = `https://${deploy.id}--gmrglibrary.netlify.app`;
    console.log('[Publish] Live at: ' + deployUrl);
    res.json({ url: deployUrl, deployId: deploy.id });
  } catch (err) {
    console.error('[Publish] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/feedback', async (req, res) => {
  res.json({ success: true, message: 'Feedback received' });
});
app.listen(PORT, () => console.log(`GMRG API server running on port ${PORT}`));
