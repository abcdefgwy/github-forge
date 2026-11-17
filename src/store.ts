/**
 * @fileoverview 全内存 GitHub Forge 核心数据存储。
 * 统一服务 Git Smart HTTP、REST v3、GraphQL v4 与 MCP，保证跨接口数据强一致性与极致性能。
 */

import {
  ZERO_OID,
  buildCommitData,
  buildTreeData,
  hashGitObject,
  parseCommitData,
  parseTagData,
  parseTreeData,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobjs.ts';

/** 用户信息 */
export interface User {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** 仓库标签 */
export interface Label {
  readonly name: string;
  readonly color: string;
}

/** 评论 */
export interface Comment {
  readonly id: number;
  readonly nodeId: string;
  readonly body: string;
  readonly author: string;
  readonly createdAt: string;
}

/** Issue */
export interface Issue {
  readonly id: number;
  readonly nodeId: string;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  readonly comments: Comment[];
  readonly createdAt: string;
  updatedAt: string;
}

/** Pull Request */
export interface PullRequest {
  readonly id: number;
  readonly nodeId: string;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  headSha: string;
  readonly baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly comments: Comment[];
  readonly createdAt: string;
  updatedAt: string;
}

/** PR 变更文件信息 */
export interface PullRequestFile {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

/** 全局 Node 索引条目，用于 GraphQL node(id:) 与变更操作定位 */
export type NodeTarget =
  | { readonly kind: 'Repository'; readonly repo: Repository }
  | { readonly kind: 'Issue'; readonly repo: Repository; readonly issue: Issue }
  | { readonly kind: 'PullRequest'; readonly repo: Repository; readonly pull: PullRequest }
  | { readonly kind: 'Comment'; readonly repo: Repository; readonly comment: Comment };

/** 仓库实体 */
export interface Repository {
  readonly id: number;
  readonly nodeId: string;
  readonly owner: string;
  readonly name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;

  /** Git 对象库：oid -> GitObject */
  readonly objects: Map<string, GitObject>;
  /** Git 引用表：fullRef (如 refs/heads/main) -> oid */
  readonly refs: Map<string, string>;
  /** Shallow depth=1 完整响应缓存：tipOid -> fetch v2 响应 Buffer */
  readonly shallow1Cache: Map<string, Buffer>;

  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  nextNumber: number;
}

/** 固定时间戳（用于规范化输出） */
const FIXED_TIME = '2026-11-17T00:00:00Z';
const FIXED_GIT_SIG = 'ada iversen <adaiversen@example.invalid> 1794873600 +0000';

/** 默认 Token 所有者（与套件 SCENARIO_SEED 确定性生成的 viewer 一致） */
export const DEFAULT_VIEWER: User = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

/** 通用错误类，携带 HTTP 状态码 */
export class ForgeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * 全内存 Forge 存储中心。
 */
export class ForgeStore {
  readonly viewer: User = DEFAULT_VIEWER;
  /** key: `${owner}/${name}` */
  private readonly repos = new Map<string, Repository>();
  /** 保持创建顺序的仓库列表（用于分页） */
  private readonly repoList: Repository[] = [];
  /** 全局 Node ID 索引 */
  private readonly nodeIndex = new Map<string, NodeTarget>();

  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;

  /** 校验 Bearer Token 是否有效 */
  verifyAuth(authHeader: string | undefined): boolean {
    if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
    const token = authHeader.slice(7).trim();
    if (!token) return false;
    const expected = process.env.MAKEFUN_SHOP_TOKEN;
    if (expected && expected.length > 0) {
      return token === expected;
    }
    return true;
  }

  /** 生成不透明全局 Node ID（不等于数字 databaseId） */
  private makeNodeId(prefix: string, id: number): string {
    return Buffer.from(`${prefix}:${id}`, 'utf8').toString('base64url');
  }

  /** 根据全局 Node ID 查询目标 */
  getNode(id: string): NodeTarget | undefined {
    return this.nodeIndex.get(id);
  }

  // ==========================================================================
  // 仓库管理
  // ==========================================================================

  createRepo(opts: { name: string; description?: string; private?: boolean }): Repository {
    const name = opts.name?.trim();
    if (!name) throw new ForgeError(422, 'Repository name is required');
    const key = `${this.viewer.login}/${name}`;
    if (this.repos.has(key)) {
      throw new ForgeError(422, `Repository ${name} already exists`);
    }
    const id = this.nextRepoId++;
    const nodeId = this.makeNodeId('Repository', id);
    const repo: Repository = {
      id,
      nodeId,
      owner: this.viewer.login,
      name,
      description: opts.description ?? '',
      private: Boolean(opts.private),
      defaultBranch: 'main',
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
      objects: new Map(),
      refs: new Map(),
      shallow1Cache: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.repos.set(key, repo);
    this.repoList.push(repo);
    this.nodeIndex.set(nodeId, { kind: 'Repository', repo });
    return repo;
  }

  /** 获取属于 viewer 的仓库，不存在或属于其他 owner 时均返回 404 */
  getRepo(owner: string, name: string): Repository {
    if (owner !== this.viewer.login) {
      throw new ForgeError(404, 'Not Found');
    }
    const repo = this.repos.get(`${owner}/${name}`);
    if (!repo) throw new ForgeError(404, 'Not Found');
    return repo;
  }

  /** 获取仓库（允许不存在时返回 undefined，供 GraphQL 使用） */
  findRepo(owner: string, name: string): Repository | undefined {
    if (owner !== this.viewer.login) return undefined;
    return this.repos.get(`${owner}/${name}`);
  }

  listViewerRepos(page: number, perPage: number): { items: Repository[]; hasNext: boolean; total: number } {
    const start = (page - 1) * perPage;
    const items = this.repoList.slice(start, start + perPage);
    return {
      items,
      hasNext: start + perPage < this.repoList.length,
      total: this.repoList.length,
    };
  }

  updateRepo(owner: string, name: string, patch: { description?: string; private?: boolean }): Repository {
    const repo = this.getRepo(owner, name);
    if (patch.description !== undefined) repo.description = patch.description;
    if (patch.private !== undefined) repo.private = patch.private;
    repo.updatedAt = FIXED_TIME;
    return repo;
  }

  deleteRepo(owner: string, name: string): void {
    const repo = this.getRepo(owner, name);
    this.repos.delete(`${owner}/${name}`);
    const idx = this.repoList.indexOf(repo);
    if (idx !== -1) this.repoList.splice(idx, 1);
    this.nodeIndex.delete(repo.nodeId);
  }

  // ==========================================================================
  // Git 对象与引用操作
  // ==========================================================================

  putObject(repo: Repository, type: GitObjectType, data: Buffer): GitObject {
    const oid = hashGitObject(type, data);
    const existing = repo.objects.get(oid);
    if (existing) return existing;
    const obj: GitObject = { oid, type, data };
    repo.objects.set(oid, obj);
    return obj;
  }

  addParsedObjects(repo: Repository, objs: readonly GitObject[]): void {
    for (const obj of objs) {
      if (!repo.objects.has(obj.oid)) {
        repo.objects.set(obj.oid, obj);
      }
    }
  }

  /** 解析 ref 名称或 40 位 SHA 为 commit OID */
  resolveRef(repo: Repository, refOrSha?: string): string | undefined {
    const target = refOrSha || repo.defaultBranch;
    if (/^[0-9a-f]{40}$/i.test(target)) {
      const lower = target.toLowerCase();
      return repo.objects.has(lower) ? lower : undefined;
    }
    if (target.startsWith('refs/')) {
      return repo.refs.get(target);
    }
    return repo.refs.get(`refs/heads/${target}`) ?? repo.refs.get(`refs/tags/${target}`);
  }

  /** 检查 ancestorOid 是否是 descendantOid 的祖先（包含相等） */
  isAncestor(repo: Repository, ancestorOid: string, descendantOid: string): boolean {
    if (ancestorOid === descendantOid) return true;
    const visited = new Set<string>();
    const queue: string[] = [descendantOid];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur === ancestorOid) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      const commit = parseCommitData(obj.data);
      for (const p of commit.parents) {
        if (!visited.has(p)) queue.push(p);
      }
    }
    return false;
  }

  /** 递归收集一个 tree 下所有平铺文件路径 -> { mode, oid, data } */
  readTreeFiles(repo: Repository, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string; data: Buffer }> {
    const result = new Map<string, { mode: string; oid: string; data: Buffer }>();
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return result;
    const entries = parseTreeData(obj.data);
    for (const e of entries) {
      const fullPath = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000' || e.mode === '040000') {
        const sub = this.readTreeFiles(repo, e.oid, fullPath);
        for (const [k, v] of sub) result.set(k, v);
      } else if (e.mode !== '160000') {
        const blob = repo.objects.get(e.oid);
        if (blob) {
          result.set(fullPath, { mode: e.mode, oid: e.oid, data: blob.data });
        }
      }
    }
    return result;
  }

  /** 将平铺路径 Map 重建为嵌套 Git Tree，返回根 treeOid */
  writeTreeFiles(repo: Repository, files: Map<string, { mode: string; oid: string }>): string {
    interface DirNode {
      files: TreeEntry[];
      dirs: Map<string, DirNode>;
    }
    const root: DirNode = { files: [], dirs: new Map() };

    for (const [path, info] of files) {
      const parts = path.split('/').filter(Boolean);
      if (parts.length === 0) continue;
      let cur = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const dirName = parts[i]!;
        let child = cur.dirs.get(dirName);
        if (!child) {
          child = { files: [], dirs: new Map() };
          cur.dirs.set(dirName, child);
        }
        cur = child;
      }
      cur.files.push({ mode: info.mode, name: parts[parts.length - 1]!, oid: info.oid });
    }

    const buildDir = (node: DirNode): string => {
      const entries: TreeEntry[] = [...node.files];
      for (const [name, child] of node.dirs) {
        const childOid = buildDir(child);
        entries.push({ mode: '40000', name, oid: childOid });
      }
      const treeData = buildTreeData(entries);
      return this.putObject(repo, 'tree', treeData).oid;
    };

    return buildDir(root);
  }

  /** 列出从指定 commit 开始的提交历史（按拓扑/广度顺序，最新在前） */
  listCommits(repo: Repository, startOid: string, limit = 100): Array<{ oid: string; message: string }> {
    const result: Array<{ oid: string; message: string }> = [];
    const visited = new Set<string>();
    const queue: string[] = [startOid];
    while (queue.length > 0 && result.length < limit) {
      const oid = queue.shift()!;
      if (visited.has(oid)) continue;
      visited.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parsed = parseCommitData(obj.data);
      result.push({ oid, message: parsed.message });
      for (const p of parsed.parents) {
        if (!visited.has(p)) queue.push(p);
      }
    }
    return result;
  }

  // ==========================================================================
  // Contents API (REST PUT/GET/DELETE)
  // ==========================================================================

  getContent(repo: Repository, path: string, ref?: string):
    | { kind: 'file'; path: string; sha: string; size: number; contentBase64: string }
    | { kind: 'dir'; entries: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> } {
    const cleanPath = path.replace(/^\/+|\/+$/g, '');
    const commitOid = this.resolveRef(repo, ref);
    if (!commitOid) throw new ForgeError(404, 'Not Found');
    const commitObj = repo.objects.get(commitOid);
    if (!commitObj || commitObj.type !== 'commit') throw new ForgeError(404, 'Not Found');
    const rootTreeOid = parseCommitData(commitObj.data).tree;

    if (cleanPath === '') {
      const treeObj = repo.objects.get(rootTreeOid);
      if (!treeObj) throw new ForgeError(404, 'Not Found');
      return {
        kind: 'dir',
        entries: parseTreeData(treeObj.data).map((e) => ({
          type: e.mode === '40000' || e.mode === '040000' ? 'dir' : 'file',
          name: e.name,
          path: e.name,
          sha: e.oid,
        })),
      };
    }

    const parts = cleanPath.split('/').filter(Boolean);
    let curTreeOid = rootTreeOid;
    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i]!;
      const treeObj = repo.objects.get(curTreeOid);
      if (!treeObj || treeObj.type !== 'tree') throw new ForgeError(404, 'Not Found');
      const entry = parseTreeData(treeObj.data).find((e) => e.name === segment);
      if (!entry) throw new ForgeError(404, 'Not Found');
      const isDir = entry.mode === '40000' || entry.mode === '040000';
      if (i === parts.length - 1) {
        if (isDir) {
          const dirObj = repo.objects.get(entry.oid);
          if (!dirObj) throw new ForgeError(404, 'Not Found');
          return {
            kind: 'dir',
            entries: parseTreeData(dirObj.data).map((sub) => ({
              type: sub.mode === '40000' || sub.mode === '040000' ? 'dir' : 'file',
              name: sub.name,
              path: `${cleanPath}/${sub.name}`,
              sha: sub.oid,
            })),
          };
        }
        const blobObj = repo.objects.get(entry.oid);
        if (!blobObj || blobObj.type !== 'blob') throw new ForgeError(404, 'Not Found');
        return {
          kind: 'file',
          path: cleanPath,
          sha: entry.oid,
          size: blobObj.data.length,
          contentBase64: blobObj.data.toString('base64'),
        };
      }
      if (!isDir) throw new ForgeError(404, 'Not Found');
      curTreeOid = entry.oid;
    }
    throw new ForgeError(404, 'Not Found');
  }

  putContent(
    repo: Repository,
    path: string,
    opts: { message: string; contentBase64: string; branch?: string; sha?: string },
  ): { created: boolean; contentSha: string; commitSha: string } {
    const cleanPath = path.replace(/^\/+|\/+$/g, '');
    if (!cleanPath) throw new ForgeError(422, 'Invalid path');
    const branch = opts.branch || repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const parentOid = repo.refs.get(refName);

    let files = new Map<string, { mode: string; oid: string }>();
    if (parentOid) {
      const parentObj = repo.objects.get(parentOid);
      if (parentObj && parentObj.type === 'commit') {
        const treeOid = parseCommitData(parentObj.data).tree;
        const loaded = this.readTreeFiles(repo, treeOid);
        for (const [k, v] of loaded) files.set(k, { mode: v.mode, oid: v.oid });
      }
    }

    const existing = files.get(cleanPath);
    if (existing) {
      if (opts.sha !== undefined && opts.sha.toLowerCase() !== existing.oid.toLowerCase()) {
        throw new ForgeError(409, `sha mismatch: expected ${existing.oid}, got ${opts.sha}`);
      }
    } else if (opts.sha !== undefined) {
      throw new ForgeError(409, 'File does not exist for provided sha');
    }

    const contentBuf = Buffer.from(opts.contentBase64.replace(/\s+/g, ''), 'base64');
    const blobObj = this.putObject(repo, 'blob', contentBuf);
    files.set(cleanPath, { mode: '100644', oid: blobObj.oid });

    const newTreeOid = this.writeTreeFiles(repo, files);
    const commitData = buildCommitData({
      tree: newTreeOid,
      parents: parentOid ? [parentOid] : [],
      author: FIXED_GIT_SIG,
      message: opts.message,
    });
    const commitObj = this.putObject(repo, 'commit', commitData);
    repo.refs.set(refName, commitObj.oid);
    repo.shallow1Cache.delete(commitObj.oid);

    return {
      created: existing === undefined,
      contentSha: blobObj.oid,
      commitSha: commitObj.oid,
    };
  }

  deleteContent(
    repo: Repository,
    path: string,
    opts: { message: string; sha: string; branch?: string },
  ): { commitSha: string } {
    const cleanPath = path.replace(/^\/+|\/+$/g, '');
    const branch = opts.branch || repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const parentOid = repo.refs.get(refName);
    if (!parentOid) throw new ForgeError(404, 'Not Found');
    const parentObj = repo.objects.get(parentOid);
    if (!parentObj || parentObj.type !== 'commit') throw new ForgeError(404, 'Not Found');

    const loaded = this.readTreeFiles(repo, parseCommitData(parentObj.data).tree);
    const existing = loaded.get(cleanPath);
    if (!existing) throw new ForgeError(404, 'Not Found');
    if (opts.sha && opts.sha.toLowerCase() !== existing.oid.toLowerCase()) {
      throw new ForgeError(409, `sha mismatch: expected ${existing.oid}`);
    }

    const files = new Map<string, { mode: string; oid: string }>();
    for (const [k, v] of loaded) {
      if (k !== cleanPath) files.set(k, { mode: v.mode, oid: v.oid });
    }
    const newTreeOid = this.writeTreeFiles(repo, files);
    const commitData = buildCommitData({
      tree: newTreeOid,
      parents: [parentOid],
      author: FIXED_GIT_SIG,
      message: opts.message,
    });
    const commitObj = this.putObject(repo, 'commit', commitData);
    repo.refs.set(refName, commitObj.oid);
    return { commitSha: commitObj.oid };
  }

  // ==========================================================================
  // Labels, Issues, Comments
  // ==========================================================================

  createLabel(repo: Repository, name: string, color: string): Label {
    if (!name) throw new ForgeError(422, 'Label name is required');
    const label: Label = { name, color: color || 'ededed' };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repository, opts: { title: string; body?: string; labels?: readonly string[] }): Issue {
    if (!opts.title) throw new ForgeError(422, 'Title is required');
    const resolvedLabels: Label[] = [];
    if (opts.labels) {
      for (const lName of opts.labels) {
        const label = repo.labels.get(lName);
        if (!label) throw new ForgeError(422, `Label "${lName}" does not exist`);
        resolvedLabels.push(label);
      }
    }
    const id = this.nextIssueId++;
    const nodeId = this.makeNodeId('Issue', id);
    const number = repo.nextNumber++;
    const issue: Issue = {
      id,
      nodeId,
      number,
      title: opts.title,
      body: opts.body ?? '',
      state: 'open',
      labels: resolvedLabels,
      comments: [],
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    };
    repo.issues.set(number, issue);
    this.nodeIndex.set(nodeId, { kind: 'Issue', repo, issue });
    return issue;
  }

  getIssue(repo: Repository, number: number): Issue {
    const issue = repo.issues.get(number);
    if (!issue) throw new ForgeError(404, 'Not Found');
    return issue;
  }

  updateIssue(repo: Repository, number: number, patch: { state?: 'open' | 'closed'; title?: string; body?: string }): Issue {
    const issue = this.getIssue(repo, number);
    if (patch.state !== undefined) issue.state = patch.state;
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    issue.updatedAt = FIXED_TIME;
    return issue;
  }

  addComment(repo: Repository, target: Issue | PullRequest, body: string): Comment {
    const id = this.nextCommentId++;
    const nodeId = this.makeNodeId('Comment', id);
    const comment: Comment = {
      id,
      nodeId,
      body,
      author: this.viewer.login,
      createdAt: FIXED_TIME,
    };
    target.comments.push(comment);
    this.nodeIndex.set(nodeId, { kind: 'Comment', repo, comment });
    return comment;
  }

  // ==========================================================================
  // Pull Requests & Squash Merge (含三路合并冲突检测)
  // ==========================================================================

  createPullRequest(
    repo: Repository,
    opts: { title: string; body?: string; head: string; base: string },
  ): PullRequest {
    if (!opts.title || !opts.head || !opts.base) {
      throw new ForgeError(422, 'title, head, and base are required');
    }
    const headSha = this.resolveRef(repo, opts.head);
    const baseSha = this.resolveRef(repo, opts.base);
    if (!headSha || !baseSha) {
      throw new ForgeError(422, 'head or base branch not found');
    }
    const id = this.nextPullId++;
    const nodeId = this.makeNodeId('PullRequest', id);
    const number = repo.nextNumber++;
    const pr: PullRequest = {
      id,
      nodeId,
      number,
      title: opts.title,
      body: opts.body ?? '',
      state: 'open',
      headRef: opts.head,
      headSha,
      baseRef: opts.base,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      comments: [],
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    };
    repo.pulls.set(number, pr);
    this.nodeIndex.set(nodeId, { kind: 'PullRequest', repo, pull: pr });
    return pr;
  }

  getPullRequest(repo: Repository, number: number): PullRequest {
    const pr = repo.pulls.get(number);
    if (!pr) throw new ForgeError(404, 'Not Found');
    return pr;
  }

  /** 查找两个 commit 的最近公共祖先 */
  private findMergeBase(repo: Repository, oidA: string, oidB: string): string | undefined {
    const ancestorsA = new Set<string>();
    const qA = [oidA];
    while (qA.length > 0) {
      const cur = qA.shift()!;
      if (ancestorsA.has(cur)) continue;
      ancestorsA.add(cur);
      const obj = repo.objects.get(cur);
      if (obj && obj.type === 'commit') {
        qA.push(...parseCommitData(obj.data).parents);
      }
    }
    const visitedB = new Set<string>();
    const qB = [oidB];
    while (qB.length > 0) {
      const cur = qB.shift()!;
      if (ancestorsA.has(cur)) return cur;
      if (visitedB.has(cur)) continue;
      visitedB.add(cur);
      const obj = repo.objects.get(cur);
      if (obj && obj.type === 'commit') {
        qB.push(...parseCommitData(obj.data).parents);
      }
    }
    return undefined;
  }

  private getCommitTreeFiles(repo: Repository, commitOid: string | undefined) {
    if (!commitOid) return new Map<string, { mode: string; oid: string; data: Buffer }>();
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return new Map<string, { mode: string; oid: string; data: Buffer }>();
    return this.readTreeFiles(repo, parseCommitData(obj.data).tree);
  }

  /** 计算 PR 的变更文件列表 */
  getPullRequestFiles(repo: Repository, pr: PullRequest): PullRequestFile[] {
    const headOid = pr.merged ? pr.headSha : (this.resolveRef(repo, pr.headRef) ?? pr.headSha);
    const baseOid = pr.merged ? pr.baseSha : (this.resolveRef(repo, pr.baseRef) ?? pr.baseSha);
    const lcaOid = this.findMergeBase(repo, baseOid, headOid) ?? baseOid;

    const baseFiles = this.getCommitTreeFiles(repo, lcaOid);
    const headFiles = this.getCommitTreeFiles(repo, headOid);

    const allPaths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
    const result: PullRequestFile[] = [];

    for (const p of [...allPaths].sort()) {
      const b = baseFiles.get(p);
      const h = headFiles.get(p);
      if (!b && h) {
        const lines = Math.max(1, h.data.toString('utf8').split('\n').length);
        result.push({ filename: p, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (b && !h) {
        const lines = Math.max(1, b.data.toString('utf8').split('\n').length);
        result.push({ filename: p, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (b && h && b.oid !== h.oid) {
        const oldLines = b.data.toString('utf8').split('\n').length;
        const newLines = h.data.toString('utf8').split('\n').length;
        const additions = Math.max(1, newLines);
        const deletions = Math.max(1, oldLines);
        result.push({ filename: p, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return result;
  }

  /** 检查 PR 是否可合并（三路合并冲突检测） */
  isPullRequestMergeable(repo: Repository, pr: PullRequest): boolean {
    if (pr.merged) return false;
    const headOid = this.resolveRef(repo, pr.headRef) ?? pr.headSha;
    const baseOid = this.resolveRef(repo, pr.baseRef) ?? pr.baseSha;
    const lcaOid = this.findMergeBase(repo, baseOid, headOid);

    const lcaFiles = this.getCommitTreeFiles(repo, lcaOid);
    const baseFiles = this.getCommitTreeFiles(repo, baseOid);
    const headFiles = this.getCommitTreeFiles(repo, headOid);

    const allPaths = new Set<string>([...lcaFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
    for (const p of allPaths) {
      const l = lcaFiles.get(p)?.oid;
      const b = baseFiles.get(p)?.oid;
      const h = headFiles.get(p)?.oid;
      const baseChanged = b !== l;
      const headChanged = h !== l;
      if (baseChanged && headChanged && b !== h) {
        return false; // 两分支对同一文件做了不同修改 -> 冲突
      }
    }
    return true;
  }

  /** 执行 PR Squash Merge */
  mergePullRequest(repo: Repository, number: number, message?: string): { sha: string; pull: PullRequest } {
    const pr = this.getPullRequest(repo, number);
    if (pr.merged) throw new ForgeError(405, 'Pull request is already merged');

    const headOid = this.resolveRef(repo, pr.headRef) ?? pr.headSha;
    const baseOid = this.resolveRef(repo, pr.baseRef) ?? pr.baseSha;
    const lcaOid = this.findMergeBase(repo, baseOid, headOid);

    const lcaFiles = this.getCommitTreeFiles(repo, lcaOid);
    const baseFiles = this.getCommitTreeFiles(repo, baseOid);
    const headFiles = this.getCommitTreeFiles(repo, headOid);

    const mergedFiles = new Map<string, { mode: string; oid: string }>();
    const allPaths = new Set<string>([...lcaFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);

    for (const p of allPaths) {
      const l = lcaFiles.get(p);
      const b = baseFiles.get(p);
      const h = headFiles.get(p);
      const baseChanged = b?.oid !== l?.oid;
      const headChanged = h?.oid !== l?.oid;
      if (baseChanged && headChanged && b?.oid !== h?.oid) {
        throw new ForgeError(405, `Merge conflict on ${p}`);
      }
      const chosen = headChanged ? h : b;
      if (chosen) {
        mergedFiles.set(p, { mode: chosen.mode, oid: chosen.oid });
      }
    }

    const treeOid = this.writeTreeFiles(repo, mergedFiles);
    const commitData = buildCommitData({
      tree: treeOid,
      parents: [baseOid],
      author: FIXED_GIT_SIG,
      message: message ?? `${pr.title} (#${pr.number})`,
    });
    const commitObj = this.putObject(repo, 'commit', commitData);

    const baseFullRef = pr.baseRef.startsWith('refs/') ? pr.baseRef : `refs/heads/${pr.baseRef}`;
    repo.refs.set(baseFullRef, commitObj.oid);
    repo.shallow1Cache.delete(commitObj.oid);

    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = FIXED_TIME;
    pr.mergeCommitSha = commitObj.oid;
    pr.updatedAt = FIXED_TIME;

    return { sha: commitObj.oid, pull: pr };
  }

  // ==========================================================================
  // Git Smart-HTTP 可达性遍历辅助（支持常规与 Shallow）
  // ==========================================================================

  /** 递归收集 tree 及其子 tree 与 blob */
  private collectTreeObjects(repo: Repository, treeOid: string, excludeOids: Set<string>, out: Map<string, GitObject>): void {
    if (excludeOids.has(treeOid) || out.has(treeOid)) return;
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    out.set(treeOid, obj);
    for (const e of parseTreeData(obj.data)) {
      if (e.mode === '40000' || e.mode === '040000') {
        this.collectTreeObjects(repo, e.oid, excludeOids, out);
      } else if (e.mode !== '160000') {
        if (!excludeOids.has(e.oid) && !out.has(e.oid)) {
          const blob = repo.objects.get(e.oid);
          if (blob) out.set(e.oid, blob);
        }
      }
    }
  }

  /**
   * 收集 upload-pack 需要下发的对象集合及 shallow-info。
   */
  collectUploadPack(
    repo: Repository,
    opts: {
      wants: readonly string[];
      haves: readonly string[];
      clientShallows: readonly string[];
      deepen?: number;
    },
  ): { objects: GitObject[]; shallows: string[]; unshallows: string[] } {
    const clientShallowSet = new Set(opts.clientShallows);
    const haveSet = new Set<string>();

    // 计算客户端已拥有的对象集合（遇到 clientShallowSet 停止沿 parent 向上）
    const haveQueue = [...opts.haves];
    while (haveQueue.length > 0) {
      const oid = haveQueue.shift()!;
      if (haveSet.has(oid)) continue;
      haveSet.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      if (obj.type === 'commit') {
        const parsed = parseCommitData(obj.data);
        this.collectTreeAncestors(repo, parsed.tree, haveSet);
        if (!clientShallowSet.has(oid)) {
          for (const p of parsed.parents) {
            if (!haveSet.has(p)) haveQueue.push(p);
          }
        }
      } else if (obj.type === 'tag') {
        const parsed = parseTagData(obj.data);
        if (!haveSet.has(parsed.object)) haveQueue.push(parsed.object);
      }
    }

    const out = new Map<string, GitObject>();
    const newShallows = new Set<string>();
    const unshallows = new Set<string>();

    if (opts.deepen !== undefined && opts.deepen > 0) {
      // Shallow 模式（BFS 按深度遍历）
      const maxDepth = opts.deepen;
      const visitedDepth = new Map<string, number>();
      const queue: Array<{ oid: string; depth: number }> = [];
      for (const w of opts.wants) queue.push({ oid: w, depth: 1 });

      while (queue.length > 0) {
        const { oid, depth } = queue.shift()!;
        const prevDepth = visitedDepth.get(oid);
        if (prevDepth !== undefined && prevDepth <= depth) continue;
        visitedDepth.set(oid, depth);

        const obj = repo.objects.get(oid);
        if (!obj) continue;

        if (obj.type === 'tag') {
          if (!haveSet.has(oid)) out.set(oid, obj);
          const parsed = parseTagData(obj.data);
          queue.push({ oid: parsed.object, depth });
          continue;
        }

        if (obj.type !== 'commit') {
          if (!haveSet.has(oid)) out.set(oid, obj);
          continue;
        }

        const parsed = parseCommitData(obj.data);
        if (!haveSet.has(oid)) {
          out.set(oid, obj);
          this.collectTreeObjects(repo, parsed.tree, haveSet, out);
        }

        if (depth >= maxDepth) {
          if (parsed.parents.length > 0) {
            newShallows.add(oid);
          }
        } else {
          if (clientShallowSet.has(oid)) {
            unshallows.add(oid);
          }
          for (const p of parsed.parents) {
            // 如果新 tip 拉取且 depth=1，上面 depth>=maxDepth 已停止；若 deepen>1，继续展开
            queue.push({ oid: p, depth: depth + 1 });
          }
        }
      }
    } else {
      // 全量 / 常规增量模式
      const queue = [...opts.wants];
      const visited = new Set<string>();
      while (queue.length > 0) {
        const oid = queue.shift()!;
        if (visited.has(oid) || haveSet.has(oid)) continue;
        visited.add(oid);
        const obj = repo.objects.get(oid);
        if (!obj) continue;
        out.set(oid, obj);
        if (obj.type === 'commit') {
          const parsed = parseCommitData(obj.data);
          this.collectTreeObjects(repo, parsed.tree, haveSet, out);
          for (const p of parsed.parents) {
            if (!visited.has(p) && !haveSet.has(p)) queue.push(p);
          }
        } else if (obj.type === 'tag') {
          const parsed = parseTagData(obj.data);
          if (!visited.has(parsed.object) && !haveSet.has(parsed.object)) {
            queue.push(parsed.object);
          }
        } else if (obj.type === 'tree') {
          this.collectTreeObjects(repo, oid, haveSet, out);
        }
      }
    }

    return {
      objects: [...out.values()],
      shallows: [...newShallows],
      unshallows: [...unshallows],
    };
  }

  private collectTreeAncestors(repo: Repository, treeOid: string, set: Set<string>): void {
    if (set.has(treeOid)) return;
    set.add(treeOid);
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTreeData(obj.data)) {
      if (e.mode === '40000' || e.mode === '040000') {
        this.collectTreeAncestors(repo, e.oid, set);
      } else if (e.mode !== '160000') {
        set.add(e.oid);
      }
    }
  }

  /** 解析 tag 指向的最终对象 OID（peel） */
  peelTag(repo: Repository, oid: string): string | undefined {
    let cur = oid;
    let obj = repo.objects.get(cur);
    let peeled = false;
    while (obj && obj.type === 'tag') {
      cur = parseTagData(obj.data).object;
      obj = repo.objects.get(cur);
      peeled = true;
    }
    return peeled ? cur : undefined;
  }
}
