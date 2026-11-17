/**
 * @fileoverview GitHub GraphQL v4 API 实现（POST /api/graphql）。
 * 内置零依赖递归下降 GraphQL 解析器、Introspection、Relay Node、游标分页与批量操作支持。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ForgeStore, Issue, PullRequest, Repository } from './store.ts';

// ============================================================================
// GraphQL 词法与语法解析器
// ============================================================================

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = src.length;
  while (i < len) {
    const ch = src.charCodeAt(i);
    // 空白或逗号
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 44) {
      i++;
      continue;
    }
    // 注释 #
    if (ch === 35) {
      while (i < len && src.charCodeAt(i) !== 10) i++;
      continue;
    }
    // 展开符 ...
    if (ch === 46 && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    // 标点 { } ( ) : [ ] ! = @
    if (
      ch === 123 || ch === 125 || ch === 40 || ch === 41 ||
      ch === 58 || ch === 91 || ch === 93 || ch === 33 || ch === 61 || ch === 64
    ) {
      tokens.push({ kind: 'punct', value: src[i]! });
      i++;
      continue;
    }
    // $ 变量前缀也作为 punct
    if (ch === 36) {
      tokens.push({ kind: 'punct', value: '$' });
      i++;
      continue;
    }
    // 字符串
    if (ch === 34) {
      i++;
      let str = '';
      while (i < len && src.charCodeAt(i) !== 34) {
        if (src.charCodeAt(i) === 92) {
          i++;
          const esc = src[i++];
          if (esc === 'n') str += '\n';
          else if (esc === 't') str += '\t';
          else if (esc === 'r') str += '\r';
          else str += esc ?? '';
        } else {
          str += src[i++];
        }
      }
      if (src.charCodeAt(i) !== 34) throw new Error('Unterminated string literal');
      i++;
      tokens.push({ kind: 'string', value: str });
      continue;
    }
    // 数字
    if ((ch >= 48 && ch <= 57) || ch === 45) {
      const start = i;
      if (ch === 45) i++;
      while (i < len && src.charCodeAt(i) >= 48 && src.charCodeAt(i) <= 57) i++;
      let isFloat = false;
      if (i < len && src.charCodeAt(i) === 46) {
        isFloat = true;
        i++;
        while (i < len && src.charCodeAt(i) >= 48 && src.charCodeAt(i) <= 57) i++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(start, i) });
      continue;
    }
    // 标识符
    if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95) {
      const start = i;
      i++;
      while (i < len) {
        const c = src.charCodeAt(i);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95) {
          i++;
        } else {
          break;
        }
      }
      tokens.push({ kind: 'name', value: src.slice(start, i) });
      continue;
    }
    throw new Error(`Unexpected character: ${src[i]}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'lit'; value: unknown }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'obj'; fields: Record<string, GqlValue> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, GqlValue>;
  selections?: SelectionNode[];
}

interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition?: string;
  selections: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'fragmentSpread';
  name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

interface OperationNode {
  opType: 'query' | 'mutation';
  name?: string;
  defaults: Record<string, unknown>;
  selections: SelectionNode[];
}

class GqlParser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(src: string) {
    this.tokens = tokenize(src);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expect(kind: TokenKind, value?: string): Token {
    const t = this.next();
    if (t.kind !== kind || (value !== undefined && t.value !== value)) {
      throw new Error(`Expected ${value ?? kind}, got ${t.value || t.kind}`);
    }
    return t;
  }

  parseDocument(): { ops: OperationNode[]; fragments: Map<string, SelectionNode[]> } {
    const ops: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();

    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') {
        ops.push({ opType: 'query', defaults: {}, selections: this.parseSelectionSet() });
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const fragName = this.expect('name').value;
        this.expect('name', 'on');
        this.expect('name');
        fragments.set(fragName, this.parseSelectionSet());
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const opType = this.next().value as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        const defaults: Record<string, unknown> = {};
        if (this.peek().kind === 'punct' && this.peek().value === '(') {
          this.next();
          while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
            this.expect('punct', '$');
            const varName = this.expect('name').value;
            this.expect('punct', ':');
            this.skipType();
            if (this.peek().kind === 'punct' && this.peek().value === '=') {
              this.next();
              const defVal = this.parseValue();
              if (defVal.kind === 'lit') defaults[varName] = defVal.value;
            }
          }
          this.next();
        }
        ops.push({ opType, name, defaults, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`Unexpected token: ${t.value}`);
      }
    }
    return { ops, fragments };
  }

  private skipType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.skipType();
      this.expect('punct', ']');
    } else {
      this.expect('name');
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('punct', '{');
    const list: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expect('name').value;
          list.push({ kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() });
        } else {
          const fragName = this.expect('name').value;
          list.push({ kind: 'fragmentSpread', name: fragName });
        }
      } else {
        let nameOrAlias = this.expect('name').value;
        let alias: string | undefined;
        if (this.peek().kind === 'punct' && this.peek().value === ':') {
          this.next();
          alias = nameOrAlias;
          nameOrAlias = this.expect('name').value;
        }
        const args: Record<string, GqlValue> = {};
        if (this.peek().kind === 'punct' && this.peek().value === '(') {
          this.next();
          while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
            const argName = this.expect('name').value;
            this.expect('punct', ':');
            args[argName] = this.parseValue();
          }
          this.next();
        }
        // 跳过指令 @include/@skip 等（如有）
        while (this.peek().kind === 'punct' && this.peek().value === '@') {
          this.next();
          this.expect('name');
          if (this.peek().kind === 'punct' && this.peek().value === '(') {
            this.next();
            let depth = 1;
            while (depth > 0) {
              const tk = this.next();
              if (tk.kind === 'punct' && tk.value === '(') depth++;
              else if (tk.kind === 'punct' && tk.value === ')') depth--;
              else if (tk.kind === 'eof') break;
            }
          }
        }
        const selections =
          this.peek().kind === 'punct' && this.peek().value === '{'
            ? this.parseSelectionSet()
            : undefined;
        list.push({ kind: 'field', alias, name: nameOrAlias, args, selections });
      }
    }
    this.next();
    return list;
  }

  private parseValue(): GqlValue {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '$') {
      this.next();
      return { kind: 'var', name: this.expect('name').value };
    }
    if (t.kind === 'int') {
      this.next();
      return { kind: 'lit', value: Number.parseInt(t.value, 10) };
    }
    if (t.kind === 'float') {
      this.next();
      return { kind: 'lit', value: Number.parseFloat(t.value) };
    }
    if (t.kind === 'string') {
      this.next();
      return { kind: 'lit', value: t.value };
    }
    if (t.kind === 'name') {
      this.next();
      if (t.value === 'true') return { kind: 'lit', value: true };
      if (t.value === 'false') return { kind: 'lit', value: false };
      if (t.value === 'null') return { kind: 'lit', value: null };
      return { kind: 'lit', value: t.value }; // Enum
    }
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      const items: GqlValue[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        items.push(this.parseValue());
      }
      this.next();
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      this.next();
      const fields: Record<string, GqlValue> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const k = this.expect('name').value;
        this.expect('punct', ':');
        fields[k] = this.parseValue();
      }
      this.next();
      return { kind: 'obj', fields };
    }
    throw new Error(`Unexpected value token: ${t.value}`);
  }
}

function evalArg(val: GqlValue | undefined, vars: Record<string, unknown>): unknown {
  if (!val) return undefined;
  if (val.kind === 'var') return vars[val.name];
  if (val.kind === 'lit') return val.value;
  if (val.kind === 'list') return val.items.map((i) => evalArg(i, vars));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val.fields)) {
    out[k] = evalArg(v, vars);
  }
  return out;
}

function evalArgs(args: Record<string, GqlValue>, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = evalArg(v, vars);
  }
  return out;
}

// ============================================================================
// Introspection Schema 定义
// ============================================================================

const SCHEMA_TYPES: Record<string, { fields?: string[]; enumValues?: string[] }> = {
  Issue: {
    fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'comments'],
  },
  PullRequest: {
    fields: [
      'id', 'number', 'title', 'state', 'body',
      'headRefName', 'baseRefName', 'mergeable', 'merged', 'mergedAt', 'files',
    ],
  },
  Repository: {
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner',
      'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled',
      'issue', 'issues', 'pullRequests', 'pullRequest',
    ],
  },
  User: {
    fields: ['id', 'login', 'name', 'email'],
  },
  Ref: {
    fields: ['name', 'target'],
  },
  SearchType: {
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  },
};

// ============================================================================
// GraphQL 执行引擎
// ============================================================================

interface ExecCtx {
  store: ForgeStore;
  vars: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: Array<{ message: string }>;
}

function expandSelections(
  selections: SelectionNode[],
  typeName: string,
  fragments: Map<string, SelectionNode[]>,
): FieldNode[] {
  const fields: FieldNode[] = [];
  for (const sel of selections) {
    if (sel.kind === 'field') {
      fields.push(sel);
    } else if (sel.kind === 'inlineFragment') {
      if (!sel.typeCondition || sel.typeCondition === typeName) {
        fields.push(...expandSelections(sel.selections, typeName, fragments));
      }
    } else if (sel.kind === 'fragmentSpread') {
      const frag = fragments.get(sel.name);
      if (frag) fields.push(...expandSelections(frag, typeName, fragments));
    }
  }
  return fields;
}

function resolveSimpleObject(
  obj: Record<string, unknown>,
  typeName: string,
  selections: SelectionNode[] | undefined,
  ctx: ExecCtx,
): Record<string, unknown> {
  if (!selections) return {};
  const out: Record<string, unknown> = {};
  for (const f of expandSelections(selections, typeName, ctx.fragments)) {
    const key = f.alias ?? f.name;
    if (f.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (!(f.name in obj)) {
      ctx.errors.push({ message: `Field '${f.name}' doesn't exist on type '${typeName}'` });
      continue;
    }
    out[key] = obj[f.name];
  }
  return out;
}

function resolveIssue(issue: Issue, selections: SelectionNode[] | undefined, ctx: ExecCtx): Record<string, unknown> {
  if (!selections) return {};
  const out: Record<string, unknown> = {};
  for (const f of expandSelections(selections, 'Issue', ctx.fragments)) {
    const key = f.alias ?? f.name;
    switch (f.name) {
      case '__typename': out[key] = 'Issue'; break;
      case 'id': out[key] = issue.nodeId; break;
      case 'number': out[key] = issue.number; break;
      case 'title': out[key] = issue.title; break;
      case 'body': out[key] = issue.body; break;
      case 'state': out[key] = issue.state.toUpperCase(); break;
      case 'createdAt': out[key] = issue.createdAt; break;
      case 'updatedAt': out[key] = issue.updatedAt; break;
      default:
        ctx.errors.push({ message: `Field '${f.name}' doesn't exist on type 'Issue'` });
    }
  }
  return out;
}

function resolvePullRequest(
  repo: Repository,
  pr: PullRequest,
  selections: SelectionNode[] | undefined,
  ctx: ExecCtx,
): Record<string, unknown> {
  if (!selections) return {};
  const out: Record<string, unknown> = {};
  for (const f of expandSelections(selections, 'PullRequest', ctx.fragments)) {
    const key = f.alias ?? f.name;
    switch (f.name) {
      case '__typename': out[key] = 'PullRequest'; break;
      case 'id': out[key] = pr.nodeId; break;
      case 'number': out[key] = pr.number; break;
      case 'title': out[key] = pr.title; break;
      case 'body': out[key] = pr.body; break;
      case 'headRefName': out[key] = pr.headRef; break;
      case 'baseRefName': out[key] = pr.baseRef; break;
      case 'merged': out[key] = pr.merged; break;
      case 'mergedAt': out[key] = pr.mergedAt; break;
      case 'state': out[key] = pr.merged ? 'MERGED' : pr.state.toUpperCase(); break;
      case 'mergeable':
        out[key] = pr.merged ? 'UNKNOWN' : ctx.store.isPullRequestMergeable(repo, pr) ? 'MERGEABLE' : 'CONFLICTING';
        break;
      case 'files': {
        const args = evalArgs(f.args, ctx.vars);
        const first = typeof args.first === 'number' ? args.first : 100;
        const files = ctx.store.getPullRequestFiles(repo, pr).slice(0, first);
        const nodes = files.map((file) => ({
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
        }));
        out[key] = resolveConnection(nodes, false, null, 'PullRequestFile', f.selections, ctx);
        break;
      }
      default:
        ctx.errors.push({ message: `Field '${f.name}' doesn't exist on type 'PullRequest'` });
    }
  }
  return out;
}

function resolveConnection(
  resolvedNodes: Record<string, unknown>[],
  hasNextPage: boolean,
  endCursor: string | null,
  _nodeType: string,
  selections: SelectionNode[] | undefined,
  ctx: ExecCtx,
): Record<string, unknown> {
  if (!selections) return {};
  const out: Record<string, unknown> = {};
  for (const f of expandSelections(selections, 'Connection', ctx.fragments)) {
    const key = f.alias ?? f.name;
    if (f.name === 'nodes') {
      out[key] = resolvedNodes;
    } else if (f.name === 'pageInfo') {
      out[key] = resolveSimpleObject({ hasNextPage, endCursor }, 'PageInfo', f.selections, ctx);
    } else if (f.name === 'totalCount') {
      out[key] = resolvedNodes.length;
    } else {
      ctx.errors.push({ message: `Field '${f.name}' doesn't exist on Connection` });
    }
  }
  return out;
}

function resolveRepository(repo: Repository, selections: SelectionNode[] | undefined, ctx: ExecCtx): Record<string, unknown> {
  if (!selections) return {};
  const out: Record<string, unknown> = {};
  for (const f of expandSelections(selections, 'Repository', ctx.fragments)) {
    const key = f.alias ?? f.name;
    switch (f.name) {
      case '__typename': out[key] = 'Repository'; break;
      case 'id': out[key] = repo.nodeId; break;
      case 'databaseId': out[key] = repo.id; break;
      case 'name': out[key] = repo.name; break;
      case 'nameWithOwner': out[key] = `${repo.owner}/${repo.name}`; break;
      case 'viewerPermission': out[key] = 'ADMIN'; break;
      case 'hasIssuesEnabled': out[key] = true; break;
      case 'owner':
        out[key] = resolveSimpleObject(
          { id: 'U_1000', login: repo.owner, name: ctx.store.viewer.name },
          'User',
          f.selections,
          ctx,
        );
        break;
      case 'defaultBranchRef': {
        const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        out[key] = headOid
          ? resolveSimpleObject({ name: repo.defaultBranch }, 'Ref', f.selections, ctx)
          : null;
        break;
      }
      case 'issue': {
        const args = evalArgs(f.args, ctx.vars);
        const num = Number(args.number);
        const issue = repo.issues.get(num);
        out[key] = issue ? resolveIssue(issue, f.selections, ctx) : null;
        break;
      }
      case 'issues': {
        const args = evalArgs(f.args, ctx.vars);
        let list = [...repo.issues.values()];
        if (Array.isArray(args.states)) {
          const allowed = new Set(args.states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => allowed.has(i.state));
        }
        const orderBy = args.orderBy as { direction?: string } | undefined;
        const dir = orderBy?.direction === 'DESC' ? -1 : 1;
        list.sort((a, b) => (a.number - b.number) * dir);

        let startIdx = 0;
        if (typeof args.after === 'string' && args.after !== '') {
          const decoded = Number.parseInt(Buffer.from(args.after, 'base64url').toString('utf8'), 10);
          if (Number.isFinite(decoded) && decoded >= 0) startIdx = decoded + 1;
        }
        const first = typeof args.first === 'number' && args.first >= 0 ? args.first : list.length;
        const pageItems = list.slice(startIdx, startIdx + first);
        const hasNextPage = startIdx + first < list.length;
        const endCursor =
          pageItems.length > 0
            ? Buffer.from(String(startIdx + pageItems.length - 1), 'utf8').toString('base64url')
            : null;

        const nodeSel = expandSelections(f.selections ?? [], 'Connection', ctx.fragments).find((s) => s.name === 'nodes')?.selections;
        const resolvedNodes = pageItems.map((i) => resolveIssue(i, nodeSel, ctx));
        out[key] = resolveConnection(resolvedNodes, hasNextPage, endCursor, 'Issue', f.selections, ctx);
        break;
      }
      case 'pullRequest': {
        const args = evalArgs(f.args, ctx.vars);
        const num = Number(args.number);
        const pr = repo.pulls.get(num);
        out[key] = pr ? resolvePullRequest(repo, pr, f.selections, ctx) : null;
        break;
      }
      case 'pullRequests': {
        const args = evalArgs(f.args, ctx.vars);
        let list = [...repo.pulls.values()];
        if (Array.isArray(args.states)) {
          const allowed = new Set(args.states.map((s) => String(s).toLowerCase()));
          list = list.filter((p) => allowed.has(p.merged ? 'merged' : p.state));
        }
        const first = typeof args.first === 'number' && args.first >= 0 ? args.first : list.length;
        const pageItems = list.slice(0, first);
        const nodeSel = expandSelections(f.selections ?? [], 'Connection', ctx.fragments).find((s) => s.name === 'nodes')?.selections;
        const resolvedNodes = pageItems.map((p) => resolvePullRequest(repo, p, nodeSel, ctx));
        out[key] = resolveConnection(resolvedNodes, first < list.length, null, 'PullRequest', f.selections, ctx);
        break;
      }
      default:
        ctx.errors.push({ message: `Field '${f.name}' doesn't exist on type 'Repository'` });
    }
  }
  return out;
}

function executeOperation(
  store: ForgeStore,
  queryStr: string,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  let doc;
  try {
    doc = new GqlParser(queryStr).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }

  const op = doc.ops[0];
  if (!op) return { data: null, errors: [{ message: 'No operation found' }] };

  const mergedVars = { ...op.defaults, ...variables };
  const ctx: ExecCtx = { store, vars: mergedVars, fragments: doc.fragments, errors: [] };
  const data: Record<string, unknown> = {};

  if (op.opType === 'query') {
    for (const f of expandSelections(op.selections, 'Query', ctx.fragments)) {
      const key = f.alias ?? f.name;
      const args = evalArgs(f.args, ctx.vars);
      switch (f.name) {
        case 'viewer':
          data[key] = resolveSimpleObject(
            { id: 'U_1000', login: store.viewer.login, name: store.viewer.name },
            'User',
            f.selections,
            ctx,
          );
          break;
        case 'repository': {
          const repo = store.findRepo(String(args.owner ?? ''), String(args.name ?? ''));
          data[key] = repo ? resolveRepository(repo, f.selections, ctx) : null;
          break;
        }
        case 'node': {
          const target = store.getNode(String(args.id ?? ''));
          if (!target) {
            data[key] = null;
          } else if (target.kind === 'Repository') {
            data[key] = resolveRepository(target.repo, f.selections, ctx);
          } else if (target.kind === 'Issue') {
            data[key] = resolveIssue(target.issue, f.selections, ctx);
          } else if (target.kind === 'PullRequest') {
            data[key] = resolvePullRequest(target.repo, target.pull, f.selections, ctx);
          } else {
            data[key] = null;
          }
          break;
        }
        case '__type': {
          const typeName = String(args.name ?? '');
          const def = SCHEMA_TYPES[typeName];
          if (!def) {
            data[key] = null;
          } else {
            const typeOut: Record<string, unknown> = {};
            for (const sub of expandSelections(f.selections ?? [], '__Type', ctx.fragments)) {
              const sk = sub.alias ?? sub.name;
              if (sub.name === 'name') typeOut[sk] = typeName;
              else if (sub.name === 'fields') {
                typeOut[sk] = (def.fields ?? []).map((fn) => ({ name: fn }));
              } else if (sub.name === 'enumValues') {
                typeOut[sk] = (def.enumValues ?? []).map((ev) => ({ name: ev }));
              }
            }
            data[key] = typeOut;
          }
          break;
        }
        default:
          ctx.errors.push({ message: `Field '${f.name}' doesn't exist on type 'Query'` });
      }
    }
  } else {
    // Mutation
    for (const f of expandSelections(op.selections, 'Mutation', ctx.fragments)) {
      const key = f.alias ?? f.name;
      const args = evalArgs(f.args, ctx.vars);
      const input = (args.input ?? {}) as Record<string, unknown>;

      try {
        switch (f.name) {
          case 'createIssue': {
            const target = store.getNode(String(input.repositoryId ?? ''));
            if (!target || target.kind !== 'Repository') throw new Error('Repository not found');
            const issue = store.createIssue(target.repo, {
              title: String(input.title ?? ''),
              body: typeof input.body === 'string' ? input.body : '',
            });
            const payload: Record<string, unknown> = {};
            for (const sub of expandSelections(f.selections ?? [], 'CreateIssuePayload', ctx.fragments)) {
              if (sub.name === 'issue') payload[sub.alias ?? 'issue'] = resolveIssue(issue, sub.selections, ctx);
            }
            data[key] = payload;
            break;
          }
          case 'closeIssue': {
            const target = store.getNode(String(input.issueId ?? ''));
            if (!target || target.kind !== 'Issue') throw new Error('Issue not found');
            const updated = store.updateIssue(target.repo, target.issue.number, { state: 'closed' });
            const payload: Record<string, unknown> = {};
            for (const sub of expandSelections(f.selections ?? [], 'CloseIssuePayload', ctx.fragments)) {
              if (sub.name === 'issue') payload[sub.alias ?? 'issue'] = resolveIssue(updated, sub.selections, ctx);
            }
            data[key] = payload;
            break;
          }
          case 'createPullRequest': {
            const target = store.getNode(String(input.repositoryId ?? ''));
            if (!target || target.kind !== 'Repository') throw new Error('Repository not found');
            const pr = store.createPullRequest(target.repo, {
              title: String(input.title ?? ''),
              body: typeof input.body === 'string' ? input.body : '',
              head: String(input.headRefName ?? ''),
              base: String(input.baseRefName ?? ''),
            });
            const payload: Record<string, unknown> = {};
            for (const sub of expandSelections(f.selections ?? [], 'CreatePullRequestPayload', ctx.fragments)) {
              if (sub.name === 'pullRequest') {
                payload[sub.alias ?? 'pullRequest'] = resolvePullRequest(target.repo, pr, sub.selections, ctx);
              }
            }
            data[key] = payload;
            break;
          }
          case 'mergePullRequest': {
            const target = store.getNode(String(input.pullRequestId ?? ''));
            if (!target || target.kind !== 'PullRequest') throw new Error('PullRequest not found');
            const { pull } = store.mergePullRequest(target.repo, target.pull.number);
            const payload: Record<string, unknown> = {};
            for (const sub of expandSelections(f.selections ?? [], 'MergePullRequestPayload', ctx.fragments)) {
              if (sub.name === 'pullRequest') {
                payload[sub.alias ?? 'pullRequest'] = resolvePullRequest(target.repo, pull, sub.selections, ctx);
              }
            }
            data[key] = payload;
            break;
          }
          case 'addComment': {
            const target = store.getNode(String(input.subjectId ?? ''));
            if (!target || (target.kind !== 'Issue' && target.kind !== 'PullRequest')) {
              throw new Error('Subject not found');
            }
            const commentTarget = target.kind === 'Issue' ? target.issue : target.pull;
            const comment = store.addComment(target.repo, commentTarget, String(input.body ?? ''));
            const payload: Record<string, unknown> = {};
            for (const sub of expandSelections(f.selections ?? [], 'AddCommentPayload', ctx.fragments)) {
              if (sub.name === 'commentEdge') {
                const edgeOut: Record<string, unknown> = {};
                for (const ef of expandSelections(sub.selections ?? [], 'IssueCommentEdge', ctx.fragments)) {
                  if (ef.name === 'node') {
                    edgeOut[ef.alias ?? 'node'] = resolveSimpleObject(
                      { id: comment.nodeId, body: comment.body },
                      'IssueComment',
                      ef.selections,
                      ctx,
                    );
                  }
                }
                payload[sub.alias ?? 'commentEdge'] = edgeOut;
              }
            }
            data[key] = payload;
            break;
          }
          default:
            ctx.errors.push({ message: `Field '${f.name}' doesn't exist on type 'Mutation'` });
        }
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : 'Mutation failed' });
      }
    }
  }

  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

/** 处理 POST /api/graphql */
export function handleGraphqlRequest(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: Buffer,
): void {
  if (!store.verifyAuth(req.headers.authorization)) {
    const body = JSON.stringify({ message: 'Requires authentication' });
    res.writeHead(401, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    const body = JSON.stringify({ errors: [{ message: 'Invalid JSON body' }] });
    res.writeHead(400, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  let result: unknown;
  if (Array.isArray(parsed)) {
    result = parsed.map((item) => {
      const rec = (item ?? {}) as Record<string, unknown>;
      return executeOperation(
        store,
        String(rec.query ?? ''),
        (rec.variables && typeof rec.variables === 'object' ? rec.variables : {}) as Record<string, unknown>,
      );
    });
  } else if (parsed && typeof parsed === 'object') {
    const rec = parsed as Record<string, unknown>;
    result = executeOperation(
      store,
      String(rec.query ?? ''),
      (rec.variables && typeof rec.variables === 'object' ? rec.variables : {}) as Record<string, unknown>,
    );
  } else {
    result = { errors: [{ message: 'Invalid GraphQL request' }] };
  }

  const out = JSON.stringify(result);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(out),
  });
  res.end(out);
}
