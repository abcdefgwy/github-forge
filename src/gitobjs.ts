/**
 * @fileoverview Git 底层对象编解码、pkt-line 帧协议与纯 Node zlib Packfile 解析/构造器。
 * 零外部依赖，专为极致内存性能与协议兼容性设计。
 */

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** 全零 OID，表示未出生分支或删除目标 */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Git 对象类型 */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** Git 内存对象表示，含可选的预压缩 pack 条目缓存 */
export interface GitObject {
  readonly oid: string;
  readonly type: GitObjectType;
  readonly data: Buffer;
  /** 预编码的 packfile 条目（变长头 + deflate 负载），避免重复压缩 */
  packedEntry?: Buffer;
}

/** Tree 条目 */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** 解析后的 Commit 对象 */
export interface ParsedCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** 解析后的 Annotated Tag 对象 */
export interface ParsedTag {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_TAG = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

const TYPE_TO_NUM: Record<GitObjectType, number> = {
  commit: OBJ_COMMIT,
  tree: OBJ_TREE,
  blob: OBJ_BLOB,
  tag: OBJ_TAG,
};

const NUM_TO_TYPE: Record<number, GitObjectType> = {
  [OBJ_COMMIT]: 'commit',
  [OBJ_TREE]: 'tree',
  [OBJ_BLOB]: 'blob',
  [OBJ_TAG]: 'tag',
};

/** 计算缓冲区的 40 位小写十六进制 SHA-1 */
export function sha1Hex(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

/** 计算缓冲区的 20 字节原始 SHA-1 */
export function sha1Raw(buf: Buffer): Buffer {
  return createHash('sha1').update(buf).digest();
}

/** 计算 Git 对象的标准 SHA-1 哈希 */
export function hashGitObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** 构造 Git Tree 排序键（目录在末尾视同附加 '/'） */
function treeSortKey(entry: TreeEntry): Buffer {
  const isDir = entry.mode === '40000' || entry.mode === '040000';
  return Buffer.from(isDir ? `${entry.name}/` : entry.name, 'utf8');
}

/** 构造规范排序的 Git Tree 原始二进制数据 */
export function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => treeSortKey(a).compare(treeSortKey(b)));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    const modeStr = e.mode === '040000' ? '40000' : e.mode;
    parts.push(Buffer.from(`${modeStr} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** 解析 Git Tree 原始二进制数据 */
export function parseTreeData(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const spaceIdx = data.indexOf(0x20, offset);
    if (spaceIdx === -1) throw new Error('无效的 tree 条目：缺少空格');
    const mode = data.subarray(offset, spaceIdx).toString('ascii');
    const nullIdx = data.indexOf(0x00, spaceIdx + 1);
    if (nullIdx === -1 || nullIdx + 21 > data.length) {
      throw new Error('无效的 tree 条目：缺少 NUL 或 SHA-1 截断');
    }
    const name = data.subarray(spaceIdx + 1, nullIdx).toString('utf8');
    const oid = data.subarray(nullIdx + 1, nullIdx + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nullIdx + 21;
  }
  return entries;
}

/** 构造 Git Commit 原始二进制数据 */
export function buildCommitData(opts: {
  tree: string;
  parents?: readonly string[];
  author: string;
  committer?: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${opts.tree}`];
  if (opts.parents) {
    for (const p of opts.parents) lines.push(`parent ${p}`);
  }
  lines.push(`author ${opts.author}`);
  lines.push(`committer ${opts.committer ?? opts.author}`);
  lines.push('');
  lines.push(opts.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** 解析 Git Commit 原始二进制数据 */
export function parseCommitData(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const headerPart = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? '' : text.slice(sep + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerPart.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** 解析 Git Annotated Tag 原始二进制数据 */
export function parseTagData(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const headerPart = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? '' : text.slice(sep + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of headerPart.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5) as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ============================================================================
// pkt-line 编解码与 side-band-64k 封装
// ============================================================================

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** 编码单条文本 pkt-line */
export function pktLine(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length + 4;
  const header = len.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), payload]);
}

/** 编码单条二进制 pkt-line */
export function pktData(payload: Buffer): Buffer {
  const len = payload.length + 4;
  const header = len.toString(16).padStart(4, '0');
  const out = Buffer.allocUnsafe(len);
  out.write(header, 0, 4, 'ascii');
  payload.copy(out, 4);
  return out;
}

/** 编码 side-band 帧（通道 1=数据, 2=进度, 3=错误），自动按 maxChunk 分片（<= 65515） */
export function sidebandFrames(band: 1 | 2 | 3, data: Buffer, maxChunk = 65515): Buffer[] {
  if (data.length === 0) return [];
  const frames: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += maxChunk) {
    const slice = data.subarray(offset, Math.min(offset + maxChunk, data.length));
    const pktLen = slice.length + 5; // 4B len + 1B band + payload
    const frame = Buffer.allocUnsafe(pktLen);
    frame.write(pktLen.toString(16).padStart(4, '0'), 0, 4, 'ascii');
    frame[4] = band;
    slice.copy(frame, 5);
    frames.push(frame);
  }
  return frames;
}

export interface PktParseResult {
  readonly packets: Array<{ kind: 'flush' | 'delim' | 'response-end' | 'data'; data?: Buffer }>;
  readonly bytesConsumed: number;
}

/**
 * 解析 pkt-line 流，直到遇到指定终止条件或缓冲区耗尽。
 * @param stopAtPack 当遇到非 pkt-line（如 'PACK' 头）时停止，或读完整个 pkt-line 区域
 */
export function parsePktLines(buf: Buffer, startOffset = 0, stopAfterFlushCount = 0): PktParseResult {
  const packets: PktParseResult['packets'] = [];
  let offset = startOffset;
  let flushCount = 0;

  while (offset < buf.length) {
    if (offset + 4 > buf.length) {
      throw new Error('pkt-line 长度前缀截断');
    }
    const lenHex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) {
      throw new Error(`非法的 pkt-line 长度前缀: ${lenHex}`);
    }
    const len = Number.parseInt(lenHex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      flushCount += 1;
      if (stopAfterFlushCount > 0 && flushCount >= stopAfterFlushCount) break;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (len === 3 || len > 65520) {
      throw new Error(`非法的 pkt-line 长度值: ${len}`);
    }
    if (offset + len > buf.length) {
      throw new Error('pkt-line 负载截断');
    }
    packets.push({ kind: 'data', data: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }

  return { packets, bytesConsumed: offset - startOffset };
}

// ============================================================================
// Packfile 编码与解码
// ============================================================================

/** 编码单个对象的 packfile 条目头（类型码 + 变长 size） */
function encodePackObjectHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = ((typeNum & 0x07) << 4) | (size & 0x0f);
  let rem = size >>> 4;
  if (rem > 0) first |= 0x80;
  bytes.push(first);
  while (rem > 0) {
    let b = rem & 0x7f;
    rem >>>= 7;
    if (rem > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** 为 GitObject 生成并缓存其 packfile 压缩条目 */
export function ensurePackedEntry(obj: GitObject): Buffer {
  if (obj.packedEntry !== undefined) return obj.packedEntry;
  const header = encodePackObjectHeader(TYPE_TO_NUM[obj.type], obj.data.length);
  const compressed = deflateSync(obj.data);
  const entry = Buffer.concat([header, compressed]);
  obj.packedEntry = entry;
  return entry;
}

/**
 * 将一组 GitObject 打包为完整的 Git Packfile（version 2 + 20B SHA-1 校验和）。
 * 自动利用对象上缓存的 packedEntry 避免重复压缩。
 */
export function buildPackfile(objects: readonly GitObject[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);

  const parts: Buffer[] = [header];
  for (const obj of objects) {
    parts.push(ensurePackedEntry(obj));
  }
  const body = Buffer.concat(parts);
  const checksum = sha1Raw(body);
  return Buffer.concat([body, checksum]);
}

/** 读取变长整数（用于 delta 源/目标大小） */
function readDeltaSize(buf: Buffer, offset: number): { size: number; nextOffset: number } {
  let size = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++]!;
    size |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { size, nextOffset: pos };
    shift += 7;
  }
  throw new Error('delta 大小编码截断');
}

/** 应用 Git delta 指令到基对象数据上 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const src = readDeltaSize(delta, 0);
  if (src.size !== base.length) {
    throw new Error(`delta 源大小不匹配: 期望 ${src.size}, 实际 ${base.length}`);
  }
  const tgt = readDeltaSize(delta, src.nextOffset);
  const out = Buffer.allocUnsafe(tgt.size);
  let pos = tgt.nextOffset;
  let outPos = 0;

  while (pos < delta.length) {
    const op = delta[pos++]!;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset |= delta[pos++]!;
      if (op & 0x02) copyOffset |= delta[pos++]! << 8;
      if (op & 0x04) copyOffset |= delta[pos++]! << 16;
      if (op & 0x08) copyOffset |= delta[pos++]! << 24;
      if (op & 0x10) copySize |= delta[pos++]!;
      if (op & 0x20) copySize |= delta[pos++]! << 8;
      if (op & 0x40) copySize |= delta[pos++]! << 16;
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length || outPos + copySize > tgt.size) {
        throw new Error('delta copy 指令越界');
      }
      base.copy(out, outPos, copyOffset, copyOffset + copySize);
      outPos += copySize;
    } else if (op > 0) {
      if (pos + op > delta.length || outPos + op > tgt.size) {
        throw new Error('delta insert 指令越界');
      }
      delta.copy(out, outPos, pos, pos + op);
      pos += op;
      outPos += op;
    } else {
      throw new Error('delta 中存在非法操作码 0x00');
    }
  }

  if (outPos !== tgt.size) {
    throw new Error(`delta 目标大小不匹配: 期望 ${tgt.size}, 实际 ${outPos}`);
  }
  return out;
}

interface RawPackEntry {
  readonly offset: number;
  readonly typeNum: number;
  readonly size: number;
  readonly data: Buffer;
  readonly baseOffset?: number;
  readonly baseOid?: string;
}

/**
 * 解析 Git Packfile（支持 version 2/3、OFS_DELTA 与 REF_DELTA）。
 * @param packBuf 完整 packfile 字节流
 * @param resolveExternalBase 解析 thin-pack 外部基对象的回调
 */
export function readPackfile(
  packBuf: Buffer,
  resolveExternalBase?: (oid: string) => GitObject | undefined,
): GitObject[] {
  if (packBuf.length < 32) throw new Error('packfile 长度不足 32 字节');
  if (packBuf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('无效的 packfile 魔数');
  }
  const version = packBuf.readUInt32BE(4);
  if (version !== 2 && version !== 3) {
    throw new Error(`不支持的 packfile 版本: ${version}`);
  }
  const expectedChecksum = packBuf.subarray(packBuf.length - 20);
  const actualChecksum = sha1Raw(packBuf.subarray(0, packBuf.length - 20));
  if (!expectedChecksum.equals(actualChecksum)) {
    throw new Error('packfile SHA-1 校验和错误');
  }

  const count = packBuf.readUInt32BE(8);
  const dataEnd = packBuf.length - 20;
  let pos = 12;

  const rawEntries: RawPackEntry[] = [];
  const byOffset = new Map<number, GitObject>();
  const byOid = new Map<string, GitObject>();
  const pendingRefDeltas: RawPackEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (pos >= dataEnd) throw new Error('packfile 对象提前结束');
    const entryOffset = pos;
    let b = packBuf[pos++]!;
    const typeNum = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while ((b & 0x80) !== 0) {
      if (pos >= dataEnd) throw new Error('packfile 对象头截断');
      b = packBuf[pos++]!;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }

    let baseOffset: number | undefined;
    let baseOid: string | undefined;

    if (typeNum === OBJ_OFS_DELTA) {
      if (pos >= dataEnd) throw new Error('OFS_DELTA 偏移截断');
      let ob = packBuf[pos++]!;
      let back = ob & 0x7f;
      while ((ob & 0x80) !== 0) {
        if (pos >= dataEnd) throw new Error('OFS_DELTA 偏移截断');
        ob = packBuf[pos++]!;
        back = (back + 1) * 128 + (ob & 0x7f);
      }
      baseOffset = entryOffset - back;
      if (baseOffset < 12 || baseOffset >= entryOffset) {
        throw new Error(`OFS_DELTA 基对象偏移越界: ${baseOffset}`);
      }
    } else if (typeNum === OBJ_REF_DELTA) {
      if (pos + 20 > dataEnd) throw new Error('REF_DELTA 基 OID 截断');
      baseOid = packBuf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else if (NUM_TO_TYPE[typeNum] === undefined) {
      throw new Error(`未知的 packfile 对象类型: ${typeNum}`);
    }

    const inf = inflateSync(packBuf.subarray(pos, dataEnd), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const inflated = inf.buffer;
    pos += inf.engine.bytesWritten;
    if (inflated.length !== size) {
      throw new Error(`packfile 对象解压大小不匹配: 期望 ${size}, 实际 ${inflated.length}`);
    }

    const entry: RawPackEntry = {
      offset: entryOffset,
      typeNum,
      size,
      data: inflated,
      baseOffset,
      baseOid,
    };
    rawEntries.push(entry);

    const objType = NUM_TO_TYPE[typeNum];
    if (objType !== undefined) {
      const oid = hashGitObject(objType, inflated);
      const obj: GitObject = { oid, type: objType, data: inflated };
      byOffset.set(entryOffset, obj);
      byOid.set(oid, obj);
    } else if (typeNum === OBJ_OFS_DELTA && baseOffset !== undefined) {
      const base = byOffset.get(baseOffset);
      if (!base) throw new Error(`OFS_DELTA 找不到基对象偏移 ${baseOffset}`);
      const resolvedData = applyDelta(base.data, inflated);
      const oid = hashGitObject(base.type, resolvedData);
      const obj: GitObject = { oid, type: base.type, data: resolvedData };
      byOffset.set(entryOffset, obj);
      byOid.set(oid, obj);
    } else if (typeNum === OBJ_REF_DELTA) {
      pendingRefDeltas.push(entry);
    }
  }

  if (pos !== dataEnd) {
    throw new Error(`packfile 尾部存在多余字节: pos=${pos}, dataEnd=${dataEnd}`);
  }

  // 解析 REF_DELTA（可能存在链式依赖，多轮收敛）
  let remaining = pendingRefDeltas;
  while (remaining.length > 0) {
    const nextRemaining: RawPackEntry[] = [];
    let progressed = false;
    for (const entry of remaining) {
      const base = byOid.get(entry.baseOid!) ?? resolveExternalBase?.(entry.baseOid!);
      if (!base) {
        nextRemaining.push(entry);
        continue;
      }
      const resolvedData = applyDelta(base.data, entry.data);
      const oid = hashGitObject(base.type, resolvedData);
      const obj: GitObject = { oid, type: base.type, data: resolvedData };
      byOffset.set(entry.offset, obj);
      byOid.set(oid, obj);
      progressed = true;
    }
    if (!progressed && nextRemaining.length > 0) {
      throw new Error(`REF_DELTA 缺少基对象: ${nextRemaining[0]!.baseOid}`);
    }
    remaining = nextRemaining;
  }

  const result: GitObject[] = [];
  for (const entry of rawEntries) {
    const obj = byOffset.get(entry.offset);
    if (!obj) throw new Error(`未能解析 packfile 条目偏移 ${entry.offset}`);
    result.push(obj);
  }
  return result;
}
