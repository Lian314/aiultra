import { execFile } from 'node:child_process';

const host = '127.0.0.1';
const port = Number(process.env.PORT || 4173);
const appUrl = `http://${host}:${port}`;
const noBrowser = process.env.AIULTRA_NO_BROWSER === '1';

function openBrowser(url) {
  const [command, args] = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error) => error ? reject(error) : resolve());
  });
}

async function waitForEnter() {
  if (!process.stdin.isTTY) return;
  console.error('按 Enter 关闭此窗口。');
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once('data', resolve));
}

let alreadyRunning = false;
try {
  const response = await fetch(appUrl, { redirect: 'manual', signal: AbortSignal.timeout(1200) });
  const page = response.ok ? await response.text() : '';
  if (page.includes('<title>AI 对话</title>')) {
    alreadyRunning = true;
  }
} catch {}

if (alreadyRunning) {
  console.log(`AI 对话已在运行: ${appUrl}`);
  if (!noBrowser) {
    try {
      await openBrowser(appUrl);
    } catch {
      console.error(`无法自动打开浏览器，请手动访问: ${appUrl}`);
      await waitForEnter();
    }
  }
} else {
  if (!noBrowser) process.env.AIULTRA_OPEN_BROWSER = '1';
  await import('./server.mjs');
}
