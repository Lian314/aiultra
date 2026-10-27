import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const host = '127.0.0.1';
const port = Number(process.env.PORT || 4173);
const directory = dirname(fileURLToPath(import.meta.url));
const maxRequestBytes = 32 * 1024;
const maxChatRequestBytes = 20 * 1024 * 1024;
const maxResponseBytes = 5 * 1024 * 1024;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

function send(response, status, body, contentType = 'application/json; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(body);
}

async function readJson(request, limit = maxRequestBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function providerUrl(value, endpoint) {
  let base;
  try { base = new URL(value); }
  catch { throw new Error('请输入有效的 API 地址。'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('API 地址必须是无凭据、无查询参数的 HTTP(S) 地址。');
  }
  const isLoopback = base.hostname === 'localhost'
    || base.hostname.endsWith('.localhost')
    || base.hostname === '[::1]'
    || (isIP(base.hostname) === 4 && Number(base.hostname.split('.')[0]) === 127);
  if (base.protocol === 'http:' && !isLoopback) {
    throw new Error('API 地址：远程接口必须使用 HTTPS，本机地址可以使用 HTTP。');
  }
  base.pathname = base.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|responses|models|messages)$/i, '');
  base.pathname = `${base.pathname}/${endpoint}`.replace(/^\/\//, '/');
  return base;
}

function searchApiBase(apiUrl, configuredUrl) {
  if (typeof configuredUrl === 'string' && configuredUrl.trim()) return configuredUrl.trim();
  let url;
  try { url = new URL(apiUrl); }
  catch { return apiUrl; }
  return url.hostname === 'api.deepseek.com' || url.hostname.endsWith('.deepseek.com')
    ? 'https://api.deepseek.com/anthropic/v1'
    : apiUrl;
}

async function readLimited(response) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxResponseBytes) {
      await reader.cancel();
      throw new Error('上游响应超过 5 MB。');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (request, response) => {
  const expectedHost = `${host}:${server.address()?.port ?? port}`;
  const origin = request.headers.origin;
  const isApiRoute = request.method === 'POST' && ['/api/models', '/api/chat', '/api/search'].includes(request.url);
  if (request.headers.host !== expectedHost || (isApiRoute && origin !== `http://${expectedHost}`) || (origin && origin !== `http://${expectedHost}`)) {
    send(response, 403, JSON.stringify({ error: 'Forbidden origin.' }));
    return;
  }

  if (request.method === 'GET' && request.url === '/') {
    try {
      const html = await readFile(join(directory, 'index.html'));
      send(response, 200, html, 'text/html; charset=utf-8');
    } catch {
      send(response, 500, JSON.stringify({ error: 'Unable to read index.html.' }));
    }
    return;
  }

  const staticAssets = new Map([
    ['/vendor/marked.umd.min.js', ['vendor/marked.umd.min.js', 'text/javascript; charset=utf-8']],
    ['/vendor/purify.min.js', ['vendor/purify.min.js', 'text/javascript; charset=utf-8']]
  ]);
  if (request.method === 'GET' && staticAssets.has(request.url)) {
    const [path, contentType] = staticAssets.get(request.url);
    try {
      const asset = await readFile(join(directory, path));
      send(response, 200, asset, contentType);
    } catch {
      send(response, 500, JSON.stringify({ error: 'Unable to read a required app asset.' }));
    }
    return;
  }

  if (request.method !== 'POST' || !['/api/models', '/api/chat', '/api/search'].includes(request.url)) {
    send(response, 404, JSON.stringify({ error: 'Not found.' }));
    return;
  }
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    send(response, 415, JSON.stringify({ error: 'Content-Type must be application/json.' }));
    return;
  }

  const isChat = request.url === '/api/chat';
  const isSearch = request.url === '/api/search';
  const controller = isChat || isSearch ? new AbortController() : null;
  if (controller) {
    request.on('aborted', () => controller.abort());
    response.on('close', () => { if (!response.writableEnded) controller.abort(); });
  }

  try {
    const body = await readJson(request, isChat ? maxChatRequestBytes : maxRequestBytes);
    if (!body || typeof body !== 'object' || typeof body.apiKey !== 'string' || !body.apiKey.trim() || typeof body.apiUrl !== 'string') {
      send(response, 400, JSON.stringify({ error: 'API address and key are required.' }));
      return;
    }
    const providerPath = isSearch
      ? 'messages'
      : !isChat
      ? 'models'
      : body.protocol === 'responses'
        ? 'responses'
        : body.protocol === 'chat'
          ? 'chat/completions'
          : '';
    if (!providerPath) {
      send(response, 400, JSON.stringify({ error: '不支持的 API 协议。' }));
      return;
    }
    if (isChat && (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload) || body.payload.stream !== true || typeof body.payload.model !== 'string')) {
      send(response, 400, JSON.stringify({ error: '对话请求格式无效。' }));
      return;
    }
    if (isSearch && (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 1000)) {
      send(response, 400, JSON.stringify({ error: '搜索内容不能为空且不能超过 1000 个字符。' }));
      return;
    }
    const searchPayload = isSearch ? {
      model: 'deepseek-v4-flash',
      max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${body.query.trim()}` }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      thinking: { type: 'disabled' }
    } : null;
    const upstreamUrl = providerUrl(isSearch ? searchApiBase(body.apiUrl, body.searchApiUrl) : body.apiUrl, providerPath);
    const upstream = await fetch(upstreamUrl, {
      method: isChat || isSearch ? 'POST' : 'GET',
      headers: isSearch
        ? { Accept: 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': body.apiKey.trim(), Authorization: `Bearer ${body.apiKey.trim()}`, 'Content-Type': 'application/json', 'User-Agent': 'deepseek-harness/0.0.1' }
        : isChat
          ? { Accept: 'text/event-stream, application/json', Authorization: `Bearer ${body.apiKey.trim()}`, 'Content-Type': 'application/json' }
        : { Accept: 'application/json', Authorization: `Bearer ${body.apiKey.trim()}` },
      ...(isChat ? { body: JSON.stringify(body.payload) } : isSearch ? { body: JSON.stringify(searchPayload) } : {}),
      redirect: 'manual',
      signal: isChat ? AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60 * 1000)]) : isSearch ? AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(25000)
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      send(response, 502, JSON.stringify({ error: '模型服务返回重定向，请将 API 地址改为最终地址。' }));
      return;
    }
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    if (isChat && contentType.toLowerCase().includes('text/event-stream') && upstream.body) {
      response.writeHead(upstream.status, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-transform',
        'X-Content-Type-Options': 'nosniff',
        'X-Accel-Buffering': 'no'
      });
      await pipeline(Readable.fromWeb(upstream.body), response);
      return;
    }
    const data = await readLimited(upstream);
    if (isSearch) {
      if (!upstream.ok) {
        let detail = '';
        try {
          const payload = JSON.parse(data.toString('utf8'));
          detail = typeof payload.error === 'string' ? payload.error : payload.error?.message || payload.message || '';
        } catch {}
        send(response, upstream.status, JSON.stringify({ error: detail || `DeepSeek 搜索服务返回 HTTP ${upstream.status}。` }));
        return;
      }
      let payload;
      try { payload = JSON.parse(data.toString('utf8')); }
      catch { send(response, 502, JSON.stringify({ error: 'DeepSeek 搜索服务返回了无效 JSON。' })); return; }
      const blocks = Array.isArray(payload?.content) ? payload.content : [];
      const snippets = new Map();
      for (const block of blocks) {
        if (block?.type !== 'text' || !Array.isArray(block.citations)) continue;
        for (const citation of block.citations) {
          if (typeof citation?.url === 'string' && typeof citation.cited_text === 'string' && !snippets.has(citation.url)) {
            snippets.set(citation.url, citation.cited_text);
          }
        }
      }
      const resultBlocks = blocks.filter((block) => block?.type === 'web_search_tool_result');
      if (!resultBlocks.length) {
        send(response, 502, JSON.stringify({ error: 'DeepSeek 没有返回网页搜索结果。请确认搜索地址支持原生 web_search 工具。' }));
        return;
      }
      const seen = new Set();
      const sources = [];
      for (const block of resultBlocks) {
        for (const item of Array.isArray(block.content) ? block.content : []) {
          if (item?.type !== 'web_search_result' || typeof item.url !== 'string' || seen.has(item.url)) continue;
          let url;
          try { url = new URL(item.url); } catch { continue; }
          if (!['http:', 'https:'].includes(url.protocol)) continue;
          seen.add(item.url);
          sources.push({
            url: item.url,
            ...(typeof item.title === 'string' && item.title ? { title: item.title.slice(0, 300) } : {}),
            ...(snippets.has(item.url) ? { snippet: snippets.get(item.url).slice(0, 1200) } : {}),
            ...(typeof item.page_age === 'string' && item.page_age ? { publishedAt: item.page_age.slice(0, 100) } : {})
          });
        }
      }
      send(response, 200, JSON.stringify({ sources }));
      return;
    }
    send(response, upstream.status, data, contentType);
  } catch (error) {
    if (controller?.signal.aborted || response.destroyed) return;
    const message = error.message === 'Request body is too large.' || error.message.startsWith('上游响应')
      ? error.message
      : error.name === 'TimeoutError'
        ? '连接模型服务超时。'
        : error.name === 'AbortError'
          ? '读取模型列表已取消。'
          : error.message.startsWith('API 地址') || error.message.startsWith('请输入')
            ? error.message
            : error instanceof SyntaxError
              ? '请求内容不是有效 JSON。'
              : isChat
                ? '无法连接模型服务，请检查 API 地址、密钥和网络。'
                : '无法连接模型服务，请检查 API 地址、密钥和网络。';
    const status = error.message === 'Request body is too large.'
      ? 413
      : error instanceof SyntaxError || error.message.startsWith('API 地址') || error.message.startsWith('请输入')
        ? 400
        : error.name === 'TimeoutError'
          ? 504
          : 502;
    if (!response.headersSent) send(response, status, JSON.stringify({ error: message }));
    else response.destroy(error);
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`本机端口 ${port} 已被占用，请关闭已有的 AI 对话实例后重试。`);
    process.exitCode = 1;
    if (process.env.AIULTRA_OPEN_BROWSER === '1' && process.stdin.isTTY) {
      console.error('按 Enter 关闭此窗口。');
      process.stdin.resume();
      process.stdin.once('data', () => process.exit(1));
    }
    return;
  }
  throw error;
});

server.listen(port, host, () => {
  const appUrl = `http://${host}:${server.address().port}`;
  console.log(`AI 对话已启动: ${appUrl}`);
  console.log('仅本机可访问。按 Ctrl+C 停止。');
  if (process.env.AIULTRA_OPEN_BROWSER === '1') {
    if (process.platform === 'win32') execFile('rundll32.exe', ['url.dll,FileProtocolHandler', appUrl], { windowsHide: true }, () => {});
    else if (process.platform === 'darwin') execFile('open', [appUrl], () => {});
    else execFile('xdg-open', [appUrl], () => {});
  }
});
