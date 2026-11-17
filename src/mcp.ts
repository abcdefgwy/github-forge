/**
 * @fileoverview MCP Streamable HTTP 服务端实现（POST /mcp）。
 * 支持 2026-07-28 server/discover 与传统 initialize 握手，提供 6 个核心 GitHub 工具。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { serializeIssue, serializePull, serializeRepo } from './rest.ts';
import { ForgeError, type ForgeStore } from './store.ts';

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

/** 固定工具列表（确保 tools/list 多次调用字节完全一致） */
const TOOLS_LIST: readonly McpToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get repository metadata by owner and name',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Filter by issue state (open, closed, all)' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a new pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
        merge_method: { type: 'string', description: 'Merge method (squash, merge, rebase)' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

function sendRpc(res: ServerResponse, status: number, payload: unknown, sessionId?: string): void {
  const body = JSON.stringify(payload);
  const headers: Record<string, string | number> = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  res.writeHead(status, headers);
  res.end(body);
}

function toolOk(data: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
  };
}

function toolErr(message: string) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const val = args[key];
  if (typeof val !== 'string' || val.trim() === '') {
    throw new ForgeError(400, `Missing required argument: ${key}`);
  }
  return val;
}

/** 处理 POST /mcp */
export function handleMcpRequest(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: Buffer,
): void {
  if (!store.verifyAuth(req.headers.authorization)) {
    sendRpc(res, 401, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message: 'Unauthorized' },
    });
    return;
  }

  let msg: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected JSON object');
    }
    msg = parsed as Record<string, unknown>;
  } catch {
    sendRpc(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    return;
  }

  const id = (msg.id ?? null) as string | number | null;
  const method = String(msg.method ?? '');
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;

  // 通知消息（无 id）直接返回 202
  if (msg.id === undefined || method === 'notifications/initialized') {
    res.writeHead(202);
    res.end();
    return;
  }

  if (method === 'server/discover') {
    sendRpc(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        resultType: 'discover',
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: {} },
        serverInfo: { name: 'github-forge', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    sendRpc(
      res,
      200,
      {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: { name: 'github-forge', version: '1.0.0' },
        },
      },
      'mcp-session-1',
    );
    return;
  }

  if (method === 'tools/list') {
    sendRpc(res, 200, {
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS_LIST },
    });
    return;
  }

  if (method === 'tools/call') {
    const toolName = String(params.name ?? '');
    const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;

    try {
      switch (toolName) {
        case 'create_repo': {
          const name = requireStr(args, 'name');
          const repo = store.createRepo({
            name,
            description: typeof args.description === 'string' ? args.description : '',
            private: Boolean(args.private),
          });
          sendRpc(res, 200, { jsonrpc: '2.0', id, result: toolOk(serializeRepo(repo)) });
          return;
        }
        case 'get_repo': {
          const owner = requireStr(args, 'owner');
          const repoName = requireStr(args, 'repo');
          const repo = store.getRepo(owner, repoName);
          sendRpc(res, 200, { jsonrpc: '2.0', id, result: toolOk(serializeRepo(repo)) });
          return;
        }
        case 'create_issue': {
          const owner = requireStr(args, 'owner');
          const repoName = requireStr(args, 'repo');
          const title = requireStr(args, 'title');
          const repo = store.getRepo(owner, repoName);
          const issue = store.createIssue(repo, {
            title,
            body: typeof args.body === 'string' ? args.body : '',
          });
          sendRpc(res, 200, { jsonrpc: '2.0', id, result: toolOk(serializeIssue(issue)) });
          return;
        }
        case 'list_issues': {
          const owner = requireStr(args, 'owner');
          const repoName = requireStr(args, 'repo');
          const state = typeof args.state === 'string' ? args.state : 'open';
          const repo = store.getRepo(owner, repoName);
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          list.sort((a, b) => b.number - a.number);
          sendRpc(res, 200, { jsonrpc: '2.0', id, result: toolOk(list.map(serializeIssue)) });
          return;
        }
        case 'create_pull_request': {
          const owner = requireStr(args, 'owner');
          const repoName = requireStr(args, 'repo');
          const title = requireStr(args, 'title');
          const head = requireStr(args, 'head');
          const base = requireStr(args, 'base');
          const repo = store.getRepo(owner, repoName);
          const pr = store.createPullRequest(repo, {
            title,
            head,
            base,
            body: typeof args.body === 'string' ? args.body : '',
          });
          sendRpc(res, 200, { jsonrpc: '2.0', id, result: toolOk(serializePull(pr)) });
          return;
        }
        case 'merge_pull_request': {
          const owner = requireStr(args, 'owner');
          const repoName = requireStr(args, 'repo');
          const pullNumRaw = args.pull_number;
          const pullNumber = typeof pullNumRaw === 'number' ? pullNumRaw : Number.parseInt(String(pullNumRaw ?? ''), 10);
          if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
            throw new ForgeError(400, 'Missing required argument: pull_number');
          }
          const repo = store.getRepo(owner, repoName);
          const { sha } = store.mergePullRequest(repo, pullNumber);
          sendRpc(res, 200, {
            jsonrpc: '2.0',
            id,
            result: toolOk({ merged: true, sha, message: 'Pull Request successfully merged' }),
          });
          return;
        }
        default:
          sendRpc(res, 200, {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Unknown tool: ${toolName}` },
          });
          return;
      }
    } catch (err) {
      const msgText = err instanceof Error ? err.message : 'Tool execution error';
      sendRpc(res, 200, { jsonrpc: '2.0', id, result: toolErr(msgText) });
      return;
    }
  }

  sendRpc(res, 200, {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
}
