import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { after, before, test } from 'node:test';

const host = '127.0.0.1';
let upstream;
let app;
let appOrigin;
let appPort;
let upstreamPort;
let appProcess;
let upstreamRequests = [];
let redirectTargets = 0;
let upstreamDisconnects = 0;

async function freePort() {
  const server = createServer();
  server.listen(0, host);
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

before(async () => {
  upstream = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      upstreamRequests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, accept: request.headers.accept, body,
        ...(request.headers['x-api-key'] ? { xApiKey: request.headers['x-api-key'] } : {}),
        ...(request.headers['anthropic-version'] ? { anthropicVersion: request.headers['anthropic-version'] } : {}),
        ...(request.headers['user-agent'] && request.headers['user-agent'] !== 'node' ? { userAgent: request.headers['user-agent'] } : {}) });
      if (request.method === 'POST') {
        if (request.url === '/v1/anthropic/messages') {
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            content: [
              { type: 'text', citations: [{ url: 'https://example.com/article', cited_text: 'Useful result excerpt.' }] },
              { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.com/article', title: 'Example article', page_age: 'today' }] }
            ]
          }));
          return;
        }
        if (request.url === '/v1/slow/chat/completions') {
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
          const interval = setInterval(() => response.write(': heartbeat\n\n'), 25);
          response.on('close', () => {
            clearInterval(interval);
            upstreamDisconnects++;
          });
          return;
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (request.url === '/v1/responses') {
          response.write('data: {"type":"response.output_text.delta","delta":"Hello"}\n\n');
        } else {
          response.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
        }
        response.end('data: [DONE]\n\n');
        return;
      }
    if (request.url === '/v1/redirect/models') {
      response.writeHead(302, { Location: `http://${host}:${upstreamPort}/target` }).end();
      return;
    }
    if (request.url === '/target') {
      redirectTargets++;
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":[]}');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":[{"id":"sample-model"}]}');
    })().catch((error) => {
      response.writeHead(500).end(error.message);
    });
  });
  upstream.listen(0, host);
  await once(upstream, 'listening');
  upstreamPort = upstream.address().port;

  appPort = await freePort();
  appOrigin = `http://${host}:${appPort}`;
  appProcess = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(appPort) },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  app = appOrigin;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(app);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Local helper did not start.');
});

after(async () => {
  appProcess?.kill();
  if (upstream?.listening) await new Promise((resolve) => upstream.close(resolve));
});

test('serves the app and forwards a same-origin model request', async () => {
  upstreamRequests = [];
  const page = await fetch(app);
  assert.match(await page.text(), /<title>AI 对话<\/title>/);

  const response = await fetch(`${app}/api/models`, {
    method: 'POST',
    headers: { Origin: appOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiUrl: `http://${host}:${upstreamPort}/v1`, apiKey: 'test-secret' })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: [{ id: 'sample-model' }] });
  assert.deepEqual(upstreamRequests, [{ method: 'GET', url: '/v1/models', authorization: 'Bearer test-secret', accept: 'application/json', body: '' }]);
});

test('serves the bundled Markdown parser and sanitizer from the local helper', async () => {
  const [markedResponse, purifierResponse] = await Promise.all([
    fetch(`${app}/vendor/marked.umd.min.js`),
    fetch(`${app}/vendor/purify.min.js`)
  ]);
  assert.equal(markedResponse.status, 200);
  assert.equal(purifierResponse.status, 200);
  assert.match(markedResponse.headers.get('content-type'), /javascript/);
  assert.match(purifierResponse.headers.get('content-type'), /javascript/);
  assert.ok((await markedResponse.text()).length > 1000);
  assert.ok((await purifierResponse.text()).length > 1000);
});

test('forwards both chat protocols as streamed responses', async () => {
  upstreamRequests = [];
  for (const protocol of ['chat', 'responses']) {
    const payload = protocol === 'chat'
      ? { model: 'sample-model', stream: true, messages: [{ role: 'user', content: 'Hi' }] }
      : { model: 'sample-model', stream: true, input: [{ role: 'user', content: 'Hi' }] };
    const response = await fetch(`${app}/api/chat`, {
      method: 'POST',
      headers: { Origin: appOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiUrl: `http://${host}:${upstreamPort}/v1`, apiKey: 'test-secret', protocol, payload })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.match(await response.text(), /Hello/);
  }
  assert.deepEqual(upstreamRequests.map(({ method, url, authorization, body }) => ({ method, url, authorization, body: JSON.parse(body) })), [
    { method: 'POST', url: '/v1/chat/completions', authorization: 'Bearer test-secret', body: { model: 'sample-model', stream: true, messages: [{ role: 'user', content: 'Hi' }] } },
    { method: 'POST', url: '/v1/responses', authorization: 'Bearer test-secret', body: { model: 'sample-model', stream: true, input: [{ role: 'user', content: 'Hi' }] } }
  ]);
});

test('preserves per-model reasoning settings for both protocols and leaves defaults unset', async () => {
  upstreamRequests = [];
  const requests = [
    {
      protocol: 'chat',
      payload: { model: 'deepseek-v4.1-flash', stream: true, messages: [{ role: 'user', content: 'Hi' }] }
    },
    {
      protocol: 'chat',
      payload: { model: 'deepseek-v4.1-flash', stream: true, reasoning_effort: 'off', messages: [{ role: 'user', content: 'Hi' }] }
    },
    {
      protocol: 'responses',
      payload: { model: 'gpt-5.2', stream: true, reasoning: { effort: 'xhigh' }, input: [{ role: 'user', content: 'Hi' }] }
    }
  ];

  for (const { protocol, payload } of requests) {
    const response = await fetch(`${app}/api/chat`, {
      method: 'POST',
      headers: { Origin: appOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiUrl: `http://${host}:${upstreamPort}/v1`, apiKey: 'test-secret', protocol, payload })
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Hello/);
  }

  assert.deepEqual(upstreamRequests.map(({ url, body }) => ({ url, body: JSON.parse(body) })), [
    { url: '/v1/chat/completions', body: requests[0].payload },
    { url: '/v1/chat/completions', body: requests[1].payload },
    { url: '/v1/responses', body: requests[2].payload }
  ]);
});

test('runs DeepSeek native web search through an independent Messages endpoint', async () => {
  upstreamRequests = [];
  const response = await fetch(`${app}/api/search`, {
    method: 'POST',
    headers: { Origin: appOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiUrl: 'https://chat-gateway.example/v1',
      searchApiUrl: `http://${host}:${upstreamPort}/v1/anthropic`,
      apiKey: 'test-secret',
      query: 'latest release notes'
    })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    sources: [{ url: 'https://example.com/article', title: 'Example article', snippet: 'Useful result excerpt.', publishedAt: 'today' }]
  });
  assert.deepEqual(upstreamRequests, [{
    method: 'POST',
    url: '/v1/anthropic/messages',
    authorization: 'Bearer test-secret',
    accept: 'application/json',
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Perform a web search for the query: latest release notes' }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      thinking: { type: 'disabled' }
    }),
    xApiKey: 'test-secret',
    anthropicVersion: '2023-06-01',
    userAgent: 'deepseek-harness/0.0.1'
  }]);
});

test('stopping a streamed request disconnects from the provider', async () => {
  upstreamDisconnects = 0;
  const response = await fetch(`${app}/api/chat`, {
    method: 'POST',
    headers: { Origin: appOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiUrl: `http://${host}:${upstreamPort}/v1/slow`,
      apiKey: 'test-secret',
      protocol: 'chat',
      payload: { model: 'sample-model', stream: true, messages: [{ role: 'user', content: 'Hi' }] }
    })
  });
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  await reader.cancel();
  for (let attempt = 0; attempt < 40 && upstreamDisconnects === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(upstreamDisconnects, 1);
});

test('rejects null, missing, and foreign origins before contacting the provider', async () => {
  upstreamRequests = [];
  for (const origin of ['null', undefined, 'http://example.com']) {
    const headers = { 'Content-Type': 'application/json' };
    if (origin !== undefined) headers.Origin = origin;
    const response = await fetch(`${app}/api/models`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ apiUrl: `http://${host}:${upstreamPort}/v1`, apiKey: 'test-secret' })
    });
    assert.equal(response.status, 403);
  }
  assert.equal(upstreamRequests.length, 0);
});

test('reports an occupied port instead of changing the app origin', async () => {
  const duplicate = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(appPort) },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  duplicate.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(duplicate, 'exit');
  assert.equal(code, 1);
  assert.match(stderr, /端口 .* 已被占用/);
});

test('a second packaged launcher reuses the running app', async () => {
  const duplicate = spawn(process.execPath, ['launcher.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(appPort), AIULTRA_NO_BROWSER: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  duplicate.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  const [code] = await once(duplicate, 'exit');
  assert.equal(code, 0);
  assert.match(stdout, /已在运行/);
});

test('does not follow an upstream redirect', async () => {
  redirectTargets = 0;
  const response = await fetch(`${app}/api/models`, {
    method: 'POST',
    headers: { Origin: appOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiUrl: `http://${host}:${upstreamPort}/v1/redirect`, apiKey: 'test-secret' })
  });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /重定向/);
  assert.equal(redirectTargets, 0);
});

test('rejects invalid URLs, wrong content types, and oversized request bodies', async () => {
  const makeRequest = (body, contentType = 'application/json') => fetch(`${app}/api/models`, {
    method: 'POST',
    headers: { Origin: appOrigin, 'Content-Type': contentType },
    body
  });
  const invalidUrl = await makeRequest(JSON.stringify({ apiUrl: 'file:///etc/passwd', apiKey: 'x' }));
  assert.equal(invalidUrl.status, 400);
  const insecureRemote = await makeRequest(JSON.stringify({ apiUrl: 'http://example.com/v1', apiKey: 'x' }));
  assert.equal(insecureRemote.status, 400);
  const wrongType = await makeRequest('{}', 'text/plain');
  assert.equal(wrongType.status, 415);
  const tooLarge = await makeRequest(JSON.stringify({ padding: 'x'.repeat(33 * 1024) }));
  assert.equal(tooLarge.status, 413);
});
