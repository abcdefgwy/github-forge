/**
 * @fileoverview GitHub REST v3 API 实现（/api/v3）。
 * 覆盖仓库、分支、提交、内容 CRUD、Git Refs、标签、Issues、评论、Pull Requests 与 Squash 合并。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ForgeError, type ForgeStore, type Issue, type PullRequest, type Repository } from './store.ts';

let reqCounter = 1;

function nextRequestId(): string {
  return `req-${reqCounter++}`;
}

export function sendRestJson(
  res: ServerResponse,
  status: number,
  data: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

function sendRest204(res: ServerResponse): void {
  res.writeHead(204, {
    'x-github-request-id': nextRequestId(),
  });
  res.end();
}

export function serializeRepo(repo: Repository) {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: {
      id: 1000,
      login: repo.owner,
    },
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

export function serializeIssue(issue: Issue) {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

export function serializePull(pr: PullRequest) {
  return {
    id: pr.id,
    node_id: pr.nodeId,
    number: pr.number,
    state: pr.state,
    title: pr.title,
    body: pr.body,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: {
      ref: pr.headRef,
      sha: pr.headSha,
    },
    base: {
      ref: pr.baseRef,
      sha: pr.baseSha,
    },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
  };
}

function parseJsonBody(rawBody: Buffer): Record<string, unknown> {
  const text = rawBody.toString('utf8').trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ForgeError(400, 'Problems parsing JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ForgeError(400, 'Body should be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** 处理所有 /api/v3 请求 */
export function handleRestRequest(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  rawBody: Buffer,
): void {
  const method = (req.method ?? 'GET').toUpperCase();
  const subPath = url.pathname.slice('/api/v3'.length) || '/';

  try {
    // 根路由与元数据
    if (method === 'GET' && subPath === '/') {
      sendRestJson(
        res,
        200,
        {
          current_user_url: `http://${req.headers.host ?? '127.0.0.1'}/api/v3/user`,
          repository_url: `http://${req.headers.host ?? '127.0.0.1'}/api/v3/repos/{owner}/{repo}`,
        },
        { 'x-oauth-scopes': 'repo, user' },
      );
      return;
    }

    if (method === 'GET' && subPath === '/meta') {
      sendRestJson(res, 200, { installed_version: '3.14.0' });
      return;
    }

    // 鉴权检查
    if (!store.verifyAuth(req.headers.authorization)) {
      sendRestJson(res, 401, { message: 'Requires authentication' });
      return;
    }

    // 当前用户
    if (method === 'GET' && subPath === '/user') {
      sendRestJson(res, 200, store.viewer);
      return;
    }

    // /user/repos
    if (subPath === '/user/repos') {
      if (method === 'GET') {
        const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
        const perPage = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
        const { items, hasNext } = store.listViewerRepos(page, perPage);
        const headers: Record<string, string> = {};
        if (hasNext) {
          const host = req.headers.host ?? '127.0.0.1';
          headers['link'] = `<http://${host}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}>; rel="next"`;
        }
        sendRestJson(res, 200, items.map(serializeRepo), headers);
        return;
      }
      if (method === 'POST') {
        const body = parseJsonBody(rawBody);
        const repo = store.createRepo({
          name: String(body.name ?? ''),
          description: typeof body.description === 'string' ? body.description : '',
          private: Boolean(body.private),
        });
        sendRestJson(res, 201, serializeRepo(repo));
        return;
      }
    }

    // /repos/:owner/:repo/...
    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(subPath);
    if (!repoMatch) {
      sendRestJson(res, 404, { message: 'Not Found' });
      return;
    }

    const owner = decodeURIComponent(repoMatch[1]!);
    const repoName = decodeURIComponent(repoMatch[2]!);
    const tail = repoMatch[3] ?? '';

    if (tail === '' || tail === '/') {
      if (method === 'GET') {
        const repo = store.getRepo(owner, repoName);
        sendRestJson(res, 200, serializeRepo(repo));
        return;
      }
      if (method === 'PATCH') {
        const body = parseJsonBody(rawBody);
        const repo = store.updateRepo(owner, repoName, {
          description: typeof body.description === 'string' ? body.description : undefined,
          private: typeof body.private === 'boolean' ? body.private : undefined,
        });
        sendRestJson(res, 200, serializeRepo(repo));
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        sendRest204(res);
        return;
      }
    }

    const repo = store.getRepo(owner, repoName);

    // /branches 和 /branches/:branch
    if (method === 'GET' && tail === '/branches') {
      const branches: Array<{ name: string; commit: { sha: string } }> = [];
      for (const [ref, oid] of repo.refs) {
        if (ref.startsWith('refs/heads/')) {
          branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
        }
      }
      sendRestJson(res, 200, branches);
      return;
    }

    const branchMatch = /^\/branches\/(.+)$/.exec(tail);
    if (method === 'GET' && branchMatch) {
      const bName = decodeURIComponent(branchMatch[1]!);
      const oid = repo.refs.get(`refs/heads/${bName}`);
      if (!oid) throw new ForgeError(404, 'Branch not found');
      sendRestJson(res, 200, { name: bName, commit: { sha: oid } });
      return;
    }

    // /commits
    if (method === 'GET' && tail === '/commits') {
      const shaParam = url.searchParams.get('sha') ?? undefined;
      const startOid = store.resolveRef(repo, shaParam);
      if (!startOid) {
        sendRestJson(res, 200, []);
        return;
      }
      const commits = store.listCommits(repo, startOid);
      sendRestJson(
        res,
        200,
        commits.map((c) => ({ sha: c.oid, commit: { message: c.message } })),
      );
      return;
    }

    // /git/refs
    if (method === 'POST' && tail === '/git/refs') {
      const body = parseJsonBody(rawBody);
      const ref = String(body.ref ?? '');
      const sha = String(body.sha ?? '').toLowerCase();
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
        throw new ForgeError(422, 'Invalid ref or sha');
      }
      repo.refs.set(ref, sha);
      sendRestJson(res, 201, { ref, object: { sha } });
      return;
    }

    const gitRefMatch = /^\/git\/refs\/(.+)$/.exec(tail);
    if (method === 'GET' && gitRefMatch) {
      const refSuffix = decodeURIComponent(gitRefMatch[1]!);
      const fullRef = `refs/${refSuffix}`;
      const oid = repo.refs.get(fullRef);
      if (!oid) throw new ForgeError(404, 'Not Found');
      sendRestJson(res, 200, { ref: fullRef, object: { sha: oid } });
      return;
    }

    // /contents/:path
    if (tail === '/contents' || tail.startsWith('/contents/')) {
      const filePath = decodeURIComponent(tail.slice('/contents'.length).replace(/^\/+/, ''));
      if (method === 'GET') {
        const ref = url.searchParams.get('ref') ?? undefined;
        const contentRes = store.getContent(repo, filePath, ref);
        if (contentRes.kind === 'dir') {
          sendRestJson(res, 200, contentRes.entries);
        } else {
          sendRestJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            content: contentRes.contentBase64,
            sha: contentRes.sha,
            size: contentRes.size,
            name: filePath.split('/').pop() ?? filePath,
            path: contentRes.path,
          });
        }
        return;
      }
      if (method === 'PUT') {
        const body = parseJsonBody(rawBody);
        const result = store.putContent(repo, filePath, {
          message: String(body.message ?? 'update file'),
          contentBase64: String(body.content ?? ''),
          branch: typeof body.branch === 'string' ? body.branch : undefined,
          sha: typeof body.sha === 'string' ? body.sha : undefined,
        });
        sendRestJson(res, result.created ? 201 : 200, {
          content: { sha: result.contentSha, encoding: 'base64', path: filePath },
          commit: { sha: result.commitSha },
        });
        return;
      }
      if (method === 'DELETE') {
        const body = parseJsonBody(rawBody);
        const result = store.deleteContent(repo, filePath, {
          message: String(body.message ?? 'delete file'),
          sha: String(body.sha ?? ''),
          branch: typeof body.branch === 'string' ? body.branch : undefined,
        });
        sendRestJson(res, 200, { commit: { sha: result.commitSha } });
        return;
      }
    }

    // /labels
    if (tail === '/labels') {
      if (method === 'POST') {
        const body = parseJsonBody(rawBody);
        const label = store.createLabel(repo, String(body.name ?? ''), String(body.color ?? 'ededed'));
        sendRestJson(res, 201, label);
        return;
      }
      if (method === 'GET') {
        sendRestJson(res, 200, [...repo.labels.values()]);
        return;
      }
    }

    // /issues
    if (tail === '/issues') {
      if (method === 'POST') {
        const body = parseJsonBody(rawBody);
        const labels = Array.isArray(body.labels) ? body.labels.map(String) : undefined;
        const issue = store.createIssue(repo, {
          title: String(body.title ?? ''),
          body: typeof body.body === 'string' ? body.body : '',
          labels,
        });
        sendRestJson(res, 201, serializeIssue(issue));
        return;
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const direction = url.searchParams.get('direction') ?? 'desc';
        const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
        const perPage = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));

        let items = [...repo.issues.values()];
        if (state !== 'all') {
          items = items.filter((i) => i.state === state);
        }
        items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        const sliced = items.slice((page - 1) * perPage, page * perPage);
        sendRestJson(res, 200, sliced.map(serializeIssue));
        return;
      }
    }

    // /issues/:number
    const issueMatch = /^\/issues\/(\d+)$/.exec(tail);
    if (issueMatch) {
      const num = Number.parseInt(issueMatch[1]!, 10);
      if (method === 'GET') {
        sendRestJson(res, 200, serializeIssue(store.getIssue(repo, num)));
        return;
      }
      if (method === 'PATCH') {
        const body = parseJsonBody(rawBody);
        const state = body.state === 'open' || body.state === 'closed' ? body.state : undefined;
        const updated = store.updateIssue(repo, num, {
          state,
          title: typeof body.title === 'string' ? body.title : undefined,
          body: typeof body.body === 'string' ? body.body : undefined,
        });
        sendRestJson(res, 200, serializeIssue(updated));
        return;
      }
    }

    // /issues/:number/comments
    const commentsMatch = /^\/issues\/(\d+)\/comments$/.exec(tail);
    if (commentsMatch) {
      const num = Number.parseInt(commentsMatch[1]!, 10);
      const issue = store.getIssue(repo, num);
      if (method === 'POST') {
        const body = parseJsonBody(rawBody);
        const comment = store.addComment(repo, issue, String(body.body ?? ''));
        sendRestJson(res, 201, { id: comment.id, node_id: comment.nodeId, body: comment.body });
        return;
      }
      if (method === 'GET') {
        sendRestJson(
          res,
          200,
          issue.comments.map((c) => ({ id: c.id, node_id: c.nodeId, body: c.body })),
        );
        return;
      }
    }

    // /pulls
    if (tail === '/pulls') {
      if (method === 'POST') {
        const body = parseJsonBody(rawBody);
        const pr = store.createPullRequest(repo, {
          title: String(body.title ?? ''),
          body: typeof body.body === 'string' ? body.body : '',
          head: String(body.head ?? ''),
          base: String(body.base ?? ''),
        });
        sendRestJson(res, 201, serializePull(pr));
        return;
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
        const perPage = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
        let items = [...repo.pulls.values()];
        if (state !== 'all') {
          items = items.filter((p) => p.state === state);
        }
        items.sort((a, b) => b.number - a.number);
        sendRestJson(res, 200, items.slice((page - 1) * perPage, page * perPage).map(serializePull));
        return;
      }
    }

    // /pulls/:number
    const pullMatch = /^\/pulls\/(\d+)$/.exec(tail);
    if (pullMatch && method === 'GET') {
      const num = Number.parseInt(pullMatch[1]!, 10);
      sendRestJson(res, 200, serializePull(store.getPullRequest(repo, num)));
      return;
    }

    // /pulls/:number/files
    const pullFilesMatch = /^\/pulls\/(\d+)\/files$/.exec(tail);
    if (pullFilesMatch && method === 'GET') {
      const num = Number.parseInt(pullFilesMatch[1]!, 10);
      const pr = store.getPullRequest(repo, num);
      sendRestJson(res, 200, store.getPullRequestFiles(repo, pr));
      return;
    }

    // /pulls/:number/merge
    const pullMergeMatch = /^\/pulls\/(\d+)\/merge$/.exec(tail);
    if (pullMergeMatch && method === 'PUT') {
      const num = Number.parseInt(pullMergeMatch[1]!, 10);
      const body = parseJsonBody(rawBody);
      const result = store.mergePullRequest(
        repo,
        num,
        typeof body.commit_title === 'string' ? body.commit_title : undefined,
      );
      sendRestJson(res, 200, {
        sha: result.sha,
        merged: true,
        message: 'Pull Request successfully merged',
      });
      return;
    }

    sendRestJson(res, 404, { message: 'Not Found' });
  } catch (err) {
    if (err instanceof ForgeError) {
      sendRestJson(res, err.status, { message: err.message });
      return;
    }
    sendRestJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
  }
}
