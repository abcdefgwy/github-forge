/**
 * @fileoverview Git Smart HTTP 协议实现（upload-pack v2/v0, receive-pack v0）。
 * 含预分配 v2 能力广告 Buffer 与 depth=1 浅克隆响应缓存。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  buildPackfile,
  parsePktLines,
  pktLine,
  readPackfile,
  sidebandFrames,
} from './gitobjs.ts';
import type { ForgeStore, Repository } from './store.ts';

/** 预分配的 Protocol v2 upload-pack 能力广告缓冲区（全局只读复用） */
const V2_UPLOAD_PACK_ADV = Buffer.concat([
  pktLine('# service=git-upload-pack\n'),
  PKT_FLUSH,
  pktLine('version 2\n'),
  pktLine('agent=github-forge/1.0\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);

/** 解析 URL 中的仓库信息与服务路径 */
export function matchGitRoute(
  pathname: string,
): { owner: string; repoName: string; action: 'info/refs' | 'git-upload-pack' | 'git-receive-pack' } | null {
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (!m) return null;
  return {
    owner: decodeURIComponent(m[1]!),
    repoName: decodeURIComponent(m[2]!),
    action: m[3]! as 'info/refs' | 'git-upload-pack' | 'git-receive-pack',
  };
}

function sendJsonError(res: ServerResponse, status: number, message: string): void {
  const body = JSON.stringify({ message });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 构造 v0 引用广告列表 */
function buildV0Advertisement(
  store: ForgeStore,
  repo: Repository,
  service: 'git-upload-pack' | 'git-receive-pack',
): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed multi_ack side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=github-forge/1.0`
      : 'report-status report-status-v2 delete-refs side-band-64k ofs-delta agent=github-forge/1.0';

  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refEntries: Array<{ name: string; oid: string; peeled?: string }> = [];

  if (service === 'git-upload-pack') {
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (headOid) {
      refEntries.push({ name: 'HEAD', oid: headOid });
    }
  }

  for (const refName of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(refName)!;
    const peeled = refName.startsWith('refs/tags/') ? store.peelTag(repo, oid) : undefined;
    refEntries.push({ name: refName, oid, peeled });
  }

  if (refEntries.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    for (let i = 0; i < refEntries.length; i++) {
      const entry = refEntries[i]!;
      const line = i === 0 ? `${entry.oid} ${entry.name}\0${caps}\n` : `${entry.oid} ${entry.name}\n`;
      parts.push(pktLine(line));
      if (entry.peeled) {
        parts.push(pktLine(`${entry.peeled} ${entry.name}^{}\n`));
      }
    }
  }

  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** 处理 GET /<owner>/<repo>.git/info/refs */
export function handleGitInfoRefs(
  store: ForgeStore,
  res: ServerResponse,
  owner: string,
  repoName: string,
  service: string | null,
  gitProtocolHeader: string | undefined,
): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJsonError(res, 400, 'Unsupported service');
    return;
  }
  const repo = store.findRepo(owner, repoName);
  if (!repo) {
    sendJsonError(res, 404, 'Repository not found');
    return;
  }

  const contentType =
    service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';

  let body: Buffer;
  if (service === 'git-upload-pack' && gitProtocolHeader?.includes('version=2')) {
    body = V2_UPLOAD_PACK_ADV;
  } else {
    body = buildV0Advertisement(store, repo, service);
  }

  res.writeHead(200, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

/** 处理 Protocol v2 ls-refs 命令 */
function handleV2LsRefs(store: ForgeStore, repo: Repository, lines: string[]): Buffer {
  let wantPeel = false;
  let wantSymrefs = false;
  let wantUnborn = false;
  const prefixes: string[] = [];

  for (const line of lines) {
    if (line === 'peel') wantPeel = true;
    else if (line === 'symrefs') wantSymrefs = true;
    else if (line === 'unborn') wantUnborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
  }

  const matchesPrefix = (refName: string): boolean => {
    if (prefixes.length === 0) return true;
    return prefixes.some((p) => refName.startsWith(p));
  };

  const parts: Buffer[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);

  if (matchesPrefix('HEAD')) {
    if (headOid) {
      const suffix = wantSymrefs ? ` symref-target:${headTarget}` : '';
      parts.push(pktLine(`${headOid} HEAD${suffix}\n`));
    } else if (wantUnborn) {
      const suffix = wantSymrefs ? ` symref-target:${headTarget}` : '';
      parts.push(pktLine(`unborn HEAD${suffix}\n`));
    }
  }

  for (const refName of [...repo.refs.keys()].sort()) {
    if (!matchesPrefix(refName)) continue;
    const oid = repo.refs.get(refName)!;
    let line = `${oid} ${refName}`;
    if (wantPeel && refName.startsWith('refs/tags/')) {
      const peeled = store.peelTag(repo, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }

  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** 处理 Protocol v2 fetch 命令（含 depth=1 极速缓存） */
function handleV2Fetch(store: ForgeStore, repo: Repository, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallows: string[] = [];
  let deepen: number | undefined;

  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5));
    else if (line.startsWith('have ')) haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) clientShallows.push(line.slice(8));
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(n) && n > 0) deepen = n;
    }
  }

  const isCacheableShallow1 =
    deepen === 1 && wants.length === 1 && haves.length === 0 && clientShallows.length === 0;
  const cacheKey = wants[0] ?? '';

  if (isCacheableShallow1) {
    const cached = repo.shallow1Cache.get(cacheKey);
    if (cached) return cached;
  }

  const { objects, shallows, unshallows } = store.collectUploadPack(repo, {
    wants,
    haves,
    clientShallows,
    deepen,
  });

  const parts: Buffer[] = [];
  if (deepen !== undefined || shallows.length > 0 || unshallows.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallows) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of unshallows) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(PKT_DELIM);
  }

  parts.push(pktLine('packfile\n'));
  const pack = buildPackfile(objects);
  parts.push(...sidebandFrames(1, pack));
  parts.push(PKT_FLUSH);

  const responseBuf = Buffer.concat(parts);
  if (isCacheableShallow1 && cacheKey) {
    repo.shallow1Cache.set(cacheKey, responseBuf);
  }
  return responseBuf;
}

/** 处理 POST /<owner>/<repo>.git/git-upload-pack */
export function handleGitUploadPack(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  rawBody: Buffer,
): void {
  const repo = store.findRepo(owner, repoName);
  if (!repo) {
    sendJsonError(res, 404, 'Repository not found');
    return;
  }

  const gitProtocol = String(req.headers['git-protocol'] ?? '');
  try {
    if (gitProtocol.includes('version=2')) {
      const parsed = parsePktLines(rawBody);
      let command = '';
      const args: string[] = [];
      let inArgs = false;

      for (const pkt of parsed.packets) {
        if (pkt.kind === 'delim') {
          inArgs = true;
          continue;
        }
        if (pkt.kind === 'flush') break;
        if (pkt.kind === 'data' && pkt.data) {
          const text = pkt.data.toString('utf8').replace(/\n$/, '');
          if (!inArgs) {
            if (text.startsWith('command=')) command = text.slice(8);
          } else {
            args.push(text);
          }
        }
      }

      let outBuf: Buffer;
      if (command === 'ls-refs') {
        outBuf = handleV2LsRefs(store, repo, args);
      } else if (command === 'fetch') {
        outBuf = handleV2Fetch(store, repo, args);
      } else {
        sendJsonError(res, 400, `Unsupported v2 command: ${command}`);
        return;
      }

      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-result',
        'content-length': outBuf.length,
        'cache-control': 'no-cache',
      });
      res.end(outBuf);
      return;
    }

    // Protocol v0 fallback
    const parsed = parsePktLines(rawBody);
    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallows: string[] = [];
    let deepen: number | undefined;

    for (const pkt of parsed.packets) {
      if (pkt.kind !== 'data' || !pkt.data) continue;
      const line = pkt.data.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('want ')) {
        const oid = line.slice(5).split(' ')[0]!;
        wants.push(oid);
      } else if (line.startsWith('have ')) {
        haves.push(line.slice(5));
      } else if (line.startsWith('shallow ')) {
        clientShallows.push(line.slice(8));
      } else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7), 10);
        if (Number.isFinite(n) && n > 0) deepen = n;
      }
    }

    const { objects, shallows, unshallows } = store.collectUploadPack(repo, {
      wants,
      haves,
      clientShallows,
      deepen,
    });

    const parts: Buffer[] = [];
    if (shallows.length > 0 || unshallows.length > 0) {
      for (const s of shallows) parts.push(pktLine(`shallow ${s}\n`));
      for (const u of unshallows) parts.push(pktLine(`unshallow ${u}\n`));
      parts.push(PKT_FLUSH);
    }
    parts.push(pktLine('NAK\n'));
    const pack = buildPackfile(objects);
    parts.push(...sidebandFrames(1, pack));
    parts.push(PKT_FLUSH);

    const outBuf = Buffer.concat(parts);
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-result',
      'content-length': outBuf.length,
      'cache-control': 'no-cache',
    });
    res.end(outBuf);
  } catch (err) {
    sendJsonError(res, 400, err instanceof Error ? err.message : 'Bad upload-pack request');
  }
}

/** 处理 POST /<owner>/<repo>.git/git-receive-pack */
export function handleGitReceivePack(
  store: ForgeStore,
  res: ServerResponse,
  owner: string,
  repoName: string,
  rawBody: Buffer,
): void {
  const repo = store.findRepo(owner, repoName);
  if (!repo) {
    sendJsonError(res, 404, 'Repository not found');
    return;
  }

  try {
    const parsed = parsePktLines(rawBody, 0, 1);
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    let capsStr = '';

    for (const pkt of parsed.packets) {
      if (pkt.kind !== 'data' || !pkt.data) continue;
      let line = pkt.data.toString('utf8').replace(/\n$/, '');
      const nullIdx = line.indexOf('\0');
      if (nullIdx !== -1) {
        capsStr = line.slice(nullIdx + 1);
        line = line.slice(0, nullIdx);
      }
      const parts = line.split(' ');
      if (parts.length >= 3) {
        commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
      }
    }

    const useSideband = capsStr.includes('side-band-64k');
    const packSlice = rawBody.subarray(parsed.bytesConsumed);
    const hasNonDelete = commands.some((c) => c.newOid !== ZERO_OID);

    let unpackStatus = 'unpack ok\n';
    let unpackOk = true;

    if (hasNonDelete && packSlice.length > 0) {
      try {
        const objs = readPackfile(packSlice, (oid) => repo.objects.get(oid));
        store.addParsedObjects(repo, objs);
      } catch (err) {
        unpackOk = false;
        unpackStatus = `unpack ${err instanceof Error ? err.message : 'error'}\n`;
      }
    }

    const reportLines: Buffer[] = [pktLine(unpackStatus)];
    for (const cmd of commands) {
      if (!unpackOk) {
        reportLines.push(pktLine(`ng ${cmd.ref} unpack failed\n`));
        continue;
      }
      if (cmd.newOid === ZERO_OID) {
        repo.refs.delete(cmd.ref);
        reportLines.push(pktLine(`ok ${cmd.ref}\n`));
      } else if (cmd.oldOid === ZERO_OID) {
        if (repo.refs.has(cmd.ref)) {
          reportLines.push(pktLine(`ng ${cmd.ref} already exists\n`));
        } else {
          repo.refs.set(cmd.ref, cmd.newOid);
          repo.shallow1Cache.delete(cmd.newOid);
          reportLines.push(pktLine(`ok ${cmd.ref}\n`));
        }
      } else {
        const curOid = repo.refs.get(cmd.ref);
        if (curOid !== cmd.oldOid || !store.isAncestor(repo, curOid, cmd.newOid)) {
          reportLines.push(pktLine(`ng ${cmd.ref} non-fast-forward\n`));
        } else {
          repo.refs.set(cmd.ref, cmd.newOid);
          repo.shallow1Cache.delete(cmd.newOid);
          reportLines.push(pktLine(`ok ${cmd.ref}\n`));
        }
      }
    }
    reportLines.push(PKT_FLUSH);

    const statusPayload = Buffer.concat(reportLines);
    const outBuf = useSideband
      ? Buffer.concat([...sidebandFrames(1, statusPayload), PKT_FLUSH])
      : statusPayload;

    res.writeHead(200, {
      'content-type': 'application/x-git-receive-pack-result',
      'content-length': outBuf.length,
      'cache-control': 'no-cache',
    });
    res.end(outBuf);
  } catch (err) {
    sendJsonError(res, 400, err instanceof Error ? err.message : 'Bad receive-pack request');
  }
}
