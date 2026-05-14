const https = require('node:https');
const http = require('node:http');

const DEFAULT_TIMEOUT_MS = 20000;

function callChatCompletion({ endpoint, model, apiKey, messages, timeoutMs = DEFAULT_TIMEOUT_MS, _protocol }) {
  const url = new URL('/v1/chat/completions', endpoint);
  const transport = _protocol === 'http' ? http : https;
  const payload = JSON.stringify({
    model,
    messages,
    temperature: 0,
    response_format: { type: 'json_object' }
  });

  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);

    const req = transport.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': 'fixrelay-llm'
        },
        signal: controller.signal
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          clearTimeout(timer);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            resolve({ ok: false, error: `http-${res.statusCode}` });
            return;
          }
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            resolve({ ok: false, error: 'invalid-response' });
            return;
          }
          const content = parsed?.choices?.[0]?.message?.content;
          if (typeof content !== 'string') {
            resolve({ ok: false, error: 'invalid-response' });
            return;
          }
          resolve({ ok: true, content });
        });
      }
    );

    req.on('error', (err) => {
      clearTimeout(timer);
      if (err.name === 'AbortError') return;
      resolve({ ok: false, error: 'network' });
    });

    req.write(payload);
    req.end();
  });
}

module.exports = { callChatCompletion };
