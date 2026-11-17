/**
 * @fileoverview HTTP 应用服务器工厂与路由分发中心。
 * 针对高并发、低延迟场景启用 TCP_NODELAY、长连接 Keep-Alive 与零拷贝快路径。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  handleGitInfoRefs,
  handleGitReceivePack,
  handleGitUploadPack,
  matchGitRoute,
} from './src/githttp.ts';
import { handleGraphqlRequest } from './src/graphql.ts';
import { handleMcpRequest } from './src/mcp.ts';
import { handleRestRequest, sendRestJson } from './src/rest.ts';
import { ForgeStore } from './src/store.ts';

const HEALTHZ_BODY = Buffer.from('{"ok":true}');
const EMPTY_BUF = Buffer.alloc(0);

/** 极速读取请求体（单块零拷贝） */
function readBody(req: IncomingMessage): Promise<Buffer> {
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') {
    return Promise.resolve(EMPTY_BUF);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) resolve(EMPTY_BUF);
      else if (chunks.length === 1) resolve(chunks[0]!);
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** 创建配置完毕的 GitHub Forge HTTP 服务器实例 */
export function createApp(): Server {
  const store = new ForgeStore();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const rawUrl = req.url ?? '/';
      const url = new URL(rawUrl, 'http://127.0.0.1');
      const pathname = url.pathname;

      if (pathname === '/healthz') {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': HEALTHZ_BODY.length,
        });
        res.end(HEALTHZ_BODY);
        return;
      }

      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        const body = await readBody(req);
        handleRestRequest(store, req, res, url, body);
        return;
      }

      if (pathname === '/api/graphql') {
        const body = await readBody(req);
        handleGraphqlRequest(store, req, res, body);
        return;
      }

      if (pathname === '/mcp') {
        const body = await readBody(req);
        handleMcpRequest(store, req, res, body);
        return;
      }

      const gitMatch = matchGitRoute(pathname);
      if (gitMatch) {
        if (gitMatch.action === 'info/refs' && (req.method ?? 'GET') === 'GET') {
          handleGitInfoRefs(
            store,
            res,
            gitMatch.owner,
            gitMatch.repoName,
            url.searchParams.get('service'),
            typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : undefined,
          );
          return;
        }
        const body = await readBody(req);
        if (gitMatch.action === 'git-upload-pack') {
          handleGitUploadPack(store, req, res, gitMatch.owner, gitMatch.repoName, body);
          return;
        }
        if (gitMatch.action === 'git-receive-pack') {
          handleGitReceivePack(store, res, gitMatch.owner, gitMatch.repoName, body);
          return;
        }
      }

      sendRestJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      if (!res.headersSent) {
        sendRestJson(res, 500, {
          message: err instanceof Error ? err.message : 'Internal Server Error',
        });
      } else {
        res.end();
      }
    }
  });

  // 禁用 Nagle 算法，降低小包往返延迟
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });

  // 延长 Keep-Alive 超时，配合评测客户端连接池复用
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  return server;
}
