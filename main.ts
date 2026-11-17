/**
 * @fileoverview GitHub Forge 入口程序。
 * 绑定随机端口 (0)，向 $MAKEFUN_ENV_URL/register 注册，并轮询 /done 直到收到退出信号。
 */

import { createApp } from './app.ts';

async function registerPort(envUrl: string, port: number): Promise<void> {
  let delayMs = 100;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok || res.status === 409) return;
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt === 5) {
        throw new Error(`注册端口失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 2, 1000);
    }
  }
}

async function pollDone(envUrl: string, onDone: () => void, isClosing: () => boolean): Promise<void> {
  let delayMs = 250;
  while (!isClosing()) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = (await res.json()) as { done?: boolean };
        if (data.done === true) {
          onDone();
          return;
        }
        delayMs = 250;
      }
    } catch {
      // 网络抖动或超时时忽略并退避重试
    }
    await new Promise((r) => setTimeout(r, delayMs));
    delayMs = Math.min(delayMs * 2, 2000);
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('无法获取监听端口');
  }
  const port = addr.port;
  const envUrl = process.env.MAKEFUN_ENV_URL?.replace(/\/+$/, '');

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 500).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (envUrl) {
    await registerPort(envUrl, port);
    void pollDone(envUrl, shutdown, () => closing);
  } else {
    console.log(`github-forge listening on http://127.0.0.1:${port}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
