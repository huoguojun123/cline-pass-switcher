import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('a broken upstream SSE does not stop the proxy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-pass-test-'));
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    setTimeout(() => res.socket?.destroy(), 50);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    port, upstreamBase: `http://127.0.0.1:${upstream.address().port}`,
    accounts: [{ name: 'test', key: 'fake', enabled: true }],
  }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root, env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    await Promise.race([
      new Promise((resolve) => child.stdout.on('data', (chunk) => {
        if (chunk.toString().includes('OpenAI 兼容代理地址')) resolve();
      })),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`proxy did not start: ${output}`)), 5000)),
    ]);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [], stream: true }),
    }).then((res) => res.text()));
    assert.equal(child.exitCode, null, output);
    const models = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(models.status, 200, output);
  } finally {
    child.kill();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
