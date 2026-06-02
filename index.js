const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.get('/', (req, res) => { res.json({ status: 'GMRG API running', version: '2.0.0' }); });
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
    const { html, siteName } = req.body;
    if (!html) return res.status(400).json({ error: 'Missing html' });
    const slug = (siteName || 'gmrg-tour').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    console.log(`[Publish] Creating site: ${slug}`);
    let site;
    const siteRes = await fetch('https://api.netlify.com/api/v1/sites', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${netlifyToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: slug })
    });
    if (!siteRes.ok) {
      const ts = Date.now().toString().slice(-5);
      const siteRes2 = await fetch('https://api.netlify.com/api/v1/sites', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${netlifyToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${slug}-${ts}` })
      });
      if (!siteRes2.ok) throw new Error('Failed to create site: ' + (await siteRes2.text()).slice(0, 200));
      site = await siteRes2.json();
    } else {
      site = await siteRes.json();
    }
    const siteId = site.id;
    const siteUrl = site.ssl_url || site.url;
    const htmlBuffer = Buffer.from(html, 'utf8');
    const sha1 = crypto.createHash('sha1').update(htmlBuffer).digest('hex');
    const deployRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${netlifyToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: { '/index.html': sha1 } })
    });
    if (!deployRes.ok) throw new Error('Failed to create deploy: ' + (await deployRes.text()).slice(0, 200));
    const deploy = await deployRes.json();
    const uploadRes = await fetch(`https://api.netlify.com/api/v1/deploys/${deploy.id}/files/index.html`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${netlifyToken}`, 'Content-Type': 'application/octet-stream' },
      body: htmlBuffer
    });
    if (!uploadRes.ok) throw new Error('Failed to upload: ' + (await uploadRes.text()).slice(0, 200));
    console.log(`[Publish] Live at: ${siteUrl}`);
    res.json({ url: siteUrl, siteId, deployId: deploy.id });
  } catch (err) {
    console.error('[Publish] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/feedback', async (req, res) => {
  res.json({ success: true, message: 'Feedback received' });
});
app.listen(PORT, () => console.log(`GMRG API server running on port ${PORT}`));
