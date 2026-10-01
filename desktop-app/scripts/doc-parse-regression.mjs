// 旧版 .doc 简历解析回归断言（零新增依赖）
//
// 为什么需要它：`.doc` 只是扩展名，真实载体有三种（OLE2 二进制 / RTF / HTML），
// 全部靠手写的字节级解析（CFB 容器 → FIB → CLX Piece Table → 编码解码）。这类解析
// 一旦算错偏移，方向是「静默产出乱码或漏正文」——不报错、不崩溃，AI 却拿着垃圾文本
// 生成画像与招呼语。所以必须有断言把每个环节钉死。
//
// 做法：脚本内自建最小 CFB 夹具（不依赖任何现成 .doc 样本，也不写新依赖），
// 用项目已有的 esbuild 把 docParser.ts 打成临时 CJS 后 require，逐场景断言。
//
// 夹具里的 GBK 字节由 Python 独立生成（与本解析器无共享实现，避免自我印证）：
//   张=d5c5 三=c8fd ·=a1a4 简=bcf2 历=c0fa 电=b5e7 话=bbb0 ：=a3ba
//
// 用法：node scripts/doc-parse-regression.mjs      （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// ===== 断言工具 =====
let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) pass += 1;
  else failures.push(`${name}${detail ? `\n      ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `期望：${e}\n      实际：${a}`);
}
function contains(name, haystack, needle) {
  ok(name, String(haystack).includes(needle), `期望包含：${JSON.stringify(needle)}\n      实际：${JSON.stringify(String(haystack).slice(0, 260))}`);
}
function notContains(name, haystack, needle) {
  ok(name, !String(haystack).includes(needle), `期望不含：${JSON.stringify(needle)}`);
}

// ===== 加载被测模块 =====
async function loadDocParser() {
  const dir = mkdtempSync(join(tmpdir(), 'bossclaw-doc-'));
  const outfile = join(dir, 'bundle.cjs');
  await build({
    stdin: {
      contents: "export { extractDocText } from './src/lib/bossclaw/docParser.ts';",
      resolveDir: root,
      sourcefile: 'doc-regression-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile,
    logLevel: 'silent',
  });
  const require = createRequire(import.meta.url);
  return { mod: require(outfile), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ===== 最小 CFB（Compound File Binary）夹具构造器 =====
// 布局：[header 512B] [FAT 扇区] [miniFAT 扇区] [mini 流扇区…] [目录扇区] [常规流扇区…]
// 仅用于测试：断言总扇区数 ≤ 128（单 FAT 扇区容量），超出即抛错而不是静默截断。
const SECTOR = 512;
const MINI = 64;
const SECTOR_END = 0xfffffffe;
const SECTOR_FREE = 0xffffffff;

function buildCfb(streams) {
  const miniStreams = streams.filter((s) => s.data.length < 4096);
  const mainStreams = streams.filter((s) => s.data.length >= 4096);
  const miniSectorCount = miniStreams.reduce((n, s) => n + Math.ceil(s.data.length / MINI), 0);
  const miniStreamBytes = miniSectorCount * MINI;
  const miniStreamSectors = miniStreamBytes ? Math.ceil(miniStreamBytes / SECTOR) : 0;
  const mainSectorCount = mainStreams.reduce((n, s) => n + Math.ceil(s.data.length / SECTOR), 0);

  const fatSectorCount = 1;
  const miniFatSectors = miniSectorCount ? 1 : 0;
  let cursor = fatSectorCount + miniFatSectors;
  const miniStreamStart = miniStreamSectors ? cursor : -1;
  cursor += miniStreamSectors;
  const dirStart = cursor;
  cursor += 1;
  const totalSectors = cursor + mainSectorCount;
  if (totalSectors > 128) throw new Error(`夹具超出单 FAT 扇区容量（${totalSectors} > 128）`);

  const fat = new Array(totalSectors).fill(SECTOR_FREE);
  fat[0] = 0xfffffffd; // FATSECT：扇区 0 自己就是 FAT
  if (miniFatSectors) fat[1] = SECTOR_END;
  const chainUp = (list) => {
    for (let i = 0; i < list.length; i += 1) fat[list[i]] = i === list.length - 1 ? SECTOR_END : list[i] + 1;
  };
  if (miniStreamSectors) {
    chainUp(Array.from({ length: miniStreamSectors }, (_, i) => miniStreamStart + i));
  }
  fat[dirStart] = SECTOR_END;

  let next = dirStart + 1;
  for (const s of mainStreams) {
    const n = Math.ceil(s.data.length / SECTOR);
    const list = Array.from({ length: n }, (_, i) => next + i);
    s.mainSectors = list;
    chainUp(list);
    next += n;
  }

  const miniFat = new Array(Math.max(1, miniSectorCount)).fill(SECTOR_FREE);
  const miniChunks = [];
  let miniCursor = 0;
  for (const s of miniStreams) {
    const n = Math.ceil(s.data.length / MINI);
    const list = Array.from({ length: n }, (_, i) => miniCursor + i);
    s.miniSectors = list;
    for (let i = 0; i < list.length; i += 1) miniFat[list[i]] = i === list.length - 1 ? SECTOR_END : list[i] + 1;
    miniChunks.push({ data: s.data, list });
    miniCursor += n;
  }

  const buf = Buffer.alloc((totalSectors + 1) * SECTOR);
  const off = (sector) => (sector + 1) * SECTOR;

  // ---- 头 ----
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(buf, 0);
  buf.writeUInt16LE(0x003e, 0x18); // minor version
  buf.writeUInt16LE(0x0003, 0x1a); // major version
  buf.writeUInt16LE(0xfffe, 0x1c); // byte order
  buf.writeUInt16LE(9, 0x1e); // sector shift → 512
  buf.writeUInt16LE(6, 0x20); // mini sector shift → 64
  buf.writeUInt32LE(0, 0x28); // num dir sectors（v3 恒 0）
  buf.writeUInt32LE(fatSectorCount, 0x2c);
  buf.writeUInt32LE(dirStart, 0x30);
  buf.writeUInt32LE(4096, 0x38); // mini stream cutoff
  buf.writeUInt32LE(miniFatSectors ? 1 : SECTOR_END, 0x3c);
  buf.writeUInt32LE(miniFatSectors, 0x40);
  buf.writeUInt32LE(SECTOR_END, 0x44); // 无 DIFAT 扇区
  buf.writeUInt32LE(0, 0x48);
  for (let i = 0; i < 109; i += 1) buf.writeUInt32LE(i === 0 ? 0 : SECTOR_FREE, 0x4c + i * 4);

  // ---- FAT ----
  for (let i = 0; i < 128; i += 1) buf.writeUInt32LE((fat[i] ?? SECTOR_FREE) >>> 0, off(0) + i * 4);
  // ---- miniFAT ----
  if (miniFatSectors) {
    for (let i = 0; i < 128; i += 1) buf.writeUInt32LE((miniFat[i] ?? SECTOR_FREE) >>> 0, off(1) + i * 4);
  }
  // ---- mini 流 ----
  if (miniStreamBytes) {
    const miniBuf = Buffer.alloc(miniStreamBytes);
    for (const chunk of miniChunks) {
      for (let i = 0; i < chunk.list.length; i += 1) {
        chunk.data.subarray(i * MINI, (i + 1) * MINI).copy(miniBuf, chunk.list[i] * MINI);
      }
    }
    miniBuf.copy(buf, off(miniStreamStart));
  }
  // ---- 目录 ----
  const dirOffset = off(dirStart);
  const writeEntry = (index, entry) => {
    const p = dirOffset + index * 128;
    const nameBuf = Buffer.from(`${entry.name}\u0000`, 'utf16le');
    nameBuf.copy(buf, p, 0, Math.min(nameBuf.length, 64));
    buf.writeUInt16LE(Math.min(nameBuf.length, 64), p + 0x40);
    buf.writeUInt8(entry.type, p + 0x42);
    buf.writeUInt8(1, p + 0x43);
    buf.writeInt32LE(-1, p + 0x44);
    buf.writeInt32LE(-1, p + 0x48);
    buf.writeInt32LE(-1, p + 0x4c);
    buf.writeUInt32LE(entry.startSector >>> 0, p + 0x74);
    buf.writeUInt32LE(entry.size, p + 0x78);
    buf.writeUInt32LE(0, p + 0x7c);
  };
  writeEntry(0, {
    name: 'Root Entry',
    type: 5,
    startSector: miniStreamStart < 0 ? SECTOR_END : miniStreamStart,
    size: miniStreamBytes,
  });
  streams.forEach((s, i) => {
    writeEntry(i + 1, {
      name: s.name,
      type: 2,
      startSector: s.mainSectors ? s.mainSectors[0] : s.miniSectors[0],
      size: s.data.length,
    });
  });
  // ---- 常规流数据 ----
  for (const s of mainStreams) {
    s.data.copy(buf, off(s.mainSectors[0]));
  }
  return buf;
}

// ===== Word 97-2003 夹具：WordDocument 流（FIB）+ table 流（CLX / Piece Table）=====
// withPrc：在 Pcdt 前置一段 Prc（0x01 + cbGrpprl + 数据）——真实文档里样式变更/修订后常见，
// 解析器必须能跳过它找到后面的 Pcdt，否则正文全丢。
function buildWordParts({ pieces, ccpText, oneTable = false, encrypted = false, padWd = 0, padTable = 0, withPrc = 0 }) {
  const dataOffset = 0x400;
  const chunks = [];
  const cps = [0];
  const pcdFc = [];
  let cursor = dataOffset;
  let cp = 0;
  for (const piece of pieces) {
    const bytes = piece.bytes;
    const cpLen = piece.compressed ? bytes.length : bytes.length / 2;
    // 压缩片段的 fc 记录的是「字节偏移 × 2」；未压缩是字节偏移本身
    const fcRaw = (piece.compressed ? cursor * 2 : cursor) >>> 0;
    pcdFc.push((fcRaw | (piece.compressed ? 0x40000000 : 0)) >>> 0);
    chunks.push({ offset: cursor, bytes });
    cursor += bytes.length;
    cp += cpLen;
    cps.push(cp);
  }
  let wd = Buffer.alloc(Math.max(0x200, cursor + 8));
  for (const chunk of chunks) chunk.bytes.copy(wd, chunk.offset);
  wd.writeUInt16LE(0xa5ec, 0x00); // wIdent
  wd.writeUInt16LE(0x00c1, 0x02); // nFib = 193
  wd.writeUInt16LE((oneTable ? 0x0200 : 0) | (encrypted ? 0x0100 : 0), 0x0a);
  wd.writeUInt32LE(dataOffset, 0x18); // fcMin
  wd.writeUInt32LE(cursor, 0x1c); // fcMac
  wd.writeUInt32LE(ccpText === undefined ? cp : ccpText, 0x40); // ccpText

  const clxOffset = 0x40;
  const n = pieces.length;
  const lcb = 4 * (n + 1) + 8 * n;
  const prcLen = withPrc ? 3 + withPrc : 0;
  const table = Buffer.alloc(clxOffset + prcLen + 5 + lcb + 8);
  let clx = clxOffset;
  if (withPrc) {
    table.writeUInt8(0x01, clx); // Prc
    table.writeUInt16LE(withPrc, clx + 1);
    clx += prcLen;
  }
  table.writeUInt8(0x02, clx); // Pcdt
  table.writeUInt32LE(lcb, clx + 1);
  let p = clx + 5;
  for (let i = 0; i < n + 1; i += 1) {
    table.writeUInt32LE(cps[i], p);
    p += 4;
  }
  for (let i = 0; i < n; i += 1) {
    table.writeUInt16LE(0, p);
    p += 2;
    table.writeUInt32LE(pcdFc[i], p);
    p += 4;
    table.writeUInt16LE(0, p);
    p += 2;
  }
  wd.writeUInt32LE(clxOffset, 0x01a2); // fcClx
  wd.writeUInt32LE(prcLen + lcb + 5, 0x01a6); // lcbClx：Prc（可选）+ Pcdt 前缀 1 + 长度 4 + PlcPcd
  if (padWd) wd = Buffer.concat([wd, Buffer.alloc(padWd)]);
  const tableBuf = padTable ? Buffer.concat([table, Buffer.alloc(padTable)]) : table;
  return {
    wd,
    table,
    tableBuf,
    totalCp: cp,
    streamName: oneTable ? '1Table' : '0Table',
  };
}

function makeDoc(opts) {
  const parts = buildWordParts(opts);
  return buildCfb([
    { name: 'WordDocument', data: parts.wd },
    { name: parts.streamName, data: parts.tableBuf },
  ]);
}

// ===== GBK 夹具字节（Python 独立生成，见文件头说明）=====
const GBK_MAIN = Buffer.from(
  'd5c5c8fd0d' + // 张三 + 段落符
  'c7f3d6b0d2e2cff2a3babaf3b6cbbfaab7a2b9a4b3cccaa60d' + // 求职意向：后端开发工程师
  'bdccd3fdbeadc0faa3bac4b3b4f3d1a720bcc6cbe3bbfabfc6d1a7d3ebbcbccaf520b1bebfc60d' + // 教育经历：某大学 计算机科学与技术 本科
  'bcbcc4dca3ba54797065536372697074202f204e6f64652e6a73', // 技能：TypeScript / Node.js
  'hex'
);
const TEXT_MAIN = '张三\n求职意向：后端开发工程师\n教育经历：某大学 计算机科学与技术 本科\n技能：TypeScript / Node.js';
const GBK_HTML_TITLE = Buffer.from('d5c5c8fd20a1a420bcf2c0fa', 'hex'); // 张三 · 简历
const GBK_PHONE = Buffer.from('b5e7bbb0a3ba3133383030303030303030', 'hex'); // 电话：13800000000

const { mod, cleanup } = await loadDocParser();
const { extractDocText } = mod;

const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

async function parseOrThrow(buf) {
  return extractDocText(toArrayBuffer(buf));
}
async function parseError(buf) {
  try {
    await parseOrThrow(buf);
    return null;
  } catch (e) {
    return String((e && e.message) || e);
  }
}

// ===== 一、压缩（GBK 单字节）片段：走主 FAT（WordDocument 补齐到 4KB 以上）=====
{
  const doc = makeDoc({
    pieces: [{ bytes: GBK_MAIN, compressed: true }],
    padWd: 8192,
  });
  const res = await parseOrThrow(doc);
  eq('压缩片段 · 正文与段落还原', res.text, TEXT_MAIN);
  eq('压缩片段 · method 标记为本地 DOC 解析', res.method, 'doc-local');
}

// ===== 二、Unicode（UTF-16LE）片段 =====
{
  const text = '李四\r熟练使用 TypeScript 与 React 开发前端页面';
  const doc = makeDoc({
    pieces: [{ bytes: Buffer.from(text, 'utf16le'), compressed: false }],
    padWd: 8192,
  });
  const res = await parseOrThrow(doc);
  eq('Unicode 片段 · 正文还原', res.text, '李四\n熟练使用 TypeScript 与 React 开发前端页面');
}

// ===== 三、多片段：域指令剥离 + 页眉（cp ≥ ccpText）裁剪 =====
{
  const main1 = Buffer.from(
    'cdf5cee50dbcf2c0fad5fdcec4a3bad5e2b6cecac7d6f7cec4b5b5b5c4b5dad2bbb6ced5fdcec40d',
    'hex'
  ); // 王五\r简历正文：这段是主文档的第一段正文\r
  const main2 = Buffer.from('\u0013PAGE\u0014第 1 页\u0015\r末尾还有一段正文', 'utf16le');
  const header = Buffer.from('页眉：不该出现的文本', 'utf16le');
  const main1Cp = main1.length;
  const main2Cp = main2.length / 2;
  const doc = makeDoc({
    pieces: [
      { bytes: main1, compressed: true },
      { bytes: main2, compressed: false },
      { bytes: header, compressed: false },
    ],
    ccpText: main1Cp + main2Cp,
    padWd: 8192,
  });
  const res = await parseOrThrow(doc);
  contains('多片段 · 保留域结果', res.text, '第 1 页');
  notContains('多片段 · 剥离域指令（PAGE 控制字）', res.text, 'PAGE');
  notContains('多片段 · 剥离域分隔/结束控制符', res.text, '\u0013');
  notContains('多片段 · 按 ccpText 裁掉页眉', res.text, '不该出现的文本');
  contains('多片段 · 正文完整', res.text, '末尾还有一段正文');
}

// ===== 四、ccpText 不可靠（被裁成零头）→ 回退全量，绝不丢正文 =====
{
  const main = Buffer.from(
    'd5d4c1f90dc8abb2bfd5fdcec4b6bcd4dad5e2d2bbb6cec0efa3acb2bbc4dcb1bbb2c3b5f4a3acd0e8d2aad7e3b9bbb3a4b6c8d2d4cda8b9fdd7eed0a1b3a4b6c8d0a3d1e9',
    'hex'
  );
  const doc = makeDoc({
    pieces: [{ bytes: main, compressed: true }],
    ccpText: 4, // 故意给一个明显错误的极小值
    padWd: 8192,
  });
  const res = await parseOrThrow(doc);
  contains('ccpText 异常 · 回退全量保留正文', res.text, '全部正文都在这一段里，不能被裁掉，需要足够长度');
}

// ===== 五、mini 流路径（WordDocument 与 table 都 < 4096）=====
{
  const text = '孙七\r小文件走迷你流时正文同样要足够长，才能通过最小长度校验';
  const doc = makeDoc({
    pieces: [{ bytes: Buffer.from(text, 'utf16le'), compressed: false }],
  });
  const res = await parseOrThrow(doc);
  eq('mini 流 · 正文还原', res.text, '孙七\n小文件走迷你流时正文同样要足够长，才能通过最小长度校验');
}

// ===== 六、fWhichTblStm = 1 → 必须读 1Table =====
{
  const text = '1Table 路径校验：正文长度必须超过解析器的最小长度阈值';
  const doc = makeDoc({
    pieces: [{ bytes: Buffer.from(text, 'utf16le'), compressed: false }],
    oneTable: true,
    padWd: 8192,
    padTable: 8192,
  });
  const res = await parseOrThrow(doc);
  eq('1Table · 正文还原', res.text, text);
}

// ===== 六之二、CLX 前置 Prc（真实文档常见）→ 必须跳过 Prc 才找到 Pcdt =====
{
  const text = '周八\rCLX 前置 Prc 时依然要能定位正文，正文长度需超过阈值';
  const doc = makeDoc({
    pieces: [{ bytes: Buffer.from(text, 'utf16le'), compressed: false }],
    withPrc: 12,
    padWd: 8192,
  });
  const res = await parseOrThrow(doc);
  eq('Prc 前置 · 跳过 Prc 定位正文', res.text, '周八\nCLX 前置 Prc 时依然要能定位正文，正文长度需超过阈值');
}

// ===== 七、加密文档 → 必须明确报「加密」，不给乱码 =====
{
  const doc = makeDoc({
    pieces: [{ bytes: Buffer.from('加密正文', 'utf16le'), compressed: false }],
    encrypted: true,
    padWd: 8192,
  });
  const err = await parseError(doc);
  contains('加密 DOC · 提示加密而非乱码', err, '加密');
}

// ===== 八、RTF 伪装 .doc =====
{
  // cb'ce'cc'e5 = 宋体（在 fonttbl 组内，必须被跳过）；d5c5c8fd = 张三
  const rtf = [
    '{\\rtf1\\ansi\\ansicpg936\\deff0',
    '{\\fonttbl{\\f0\\fnil\\fcharset134 \\\'cb\\\'ce\\\'cc\\\'e5;}}',
    '{\\*\\generator Riched20 10.0.19041;}\\viewkind4\\uc1',
    "\\pard\\f0\\fs21 \\'d5\\'c5\\'c8\\'fd\\par \\'b5\\'e7\\'bb\\'b0\\'a3\\'ba13800000000\\par",
    "\\'c7\\'f3\\'d6\\'b0\\'d2\\'e2\\'cf\\'f2\\'a3\\'ba\\'ba\\'f3\\'b6\\'cb\\'bf\\'aa\\'b7\\'a2\\'b9\\'a4\\'b3\\'cc\\'ca\\'a6\\par}",
  ].join('');
  const res = await parseOrThrow(Buffer.from(rtf, 'latin1'));
  contains('RTF · 正文（\\\'hh 转义还原）', res.text, '张三');
  contains('RTF · 正文（第二段）', res.text, '电话：13800000000');
  contains('RTF · 正文（第三段）', res.text, '求职意向：后端开发工程师');
  notContains('RTF · 跳过字体表（不把字体名当正文）', res.text, '宋体');
  notContains('RTF · 跳过可忽略组', res.text, 'Riched20');
  eq('RTF · method 标记', res.method, 'doc-rtf');
}

// ===== 九、HTML 伪装 .doc（GBK 编码）=====
{
  const ascii = (s) => Buffer.from(s, 'latin1');
  const html = Buffer.concat([
    ascii('<html><head><meta http-equiv="Content-Type" content="text/html; charset=gbk">'),
    ascii('<title>my-resume-title</title><style>body{font-size:12px}</style></head><body><p>'),
    GBK_HTML_TITLE,
    ascii('</p><p>'),
    GBK_PHONE,
    ascii('</p><table><tr><td>'),
    Buffer.from('b1bebfc6', 'hex'), // 本科
    ascii('</td><td>'),
    Buffer.from('bcc6cbe3bbfa', 'hex'), // 计算机
    ascii('</td></tr></table></body></html>'),
  ]);
  const res = await parseOrThrow(html);
  contains('HTML · 正文（GBK 解码）', res.text, '张三 · 简历');
  contains('HTML · 正文（第二段）', res.text, '电话：13800000000');
  contains('HTML · 表格文本保留', res.text, '计算机');
  notContains('HTML · 剥离 style', res.text, 'font-size');
  notContains('HTML · 剥离 head/title', res.text, 'my-resume-title');
  eq('HTML · method 标记', res.method, 'doc-html');
}

// ===== 十、非 .doc 内容 → 明确报错，不产出垃圾文本 =====
{
  const err = await parseError(Buffer.from('这是一段普通文本，既不是 Word 也不是 RTF/HTML 的内容。'));
  contains('未知载体 · 明确报错', err, '无法识别');
  const errEmpty = await parseError(Buffer.from([0x00, 0x01, 0x02]));
  contains('空文件 · 明确报错', errEmpty, '内容为空');
}

// ===== 十一、源码契约（口径不被后续改动悄悄回退）=====
{
  const read = (rel) => readFileSync(join(root, rel), 'utf8');
  const resumeParser = read('src/lib/bossclaw/resumeParser.ts');
  contains('契约 · resumeParser 接入 extractDocText', resumeParser, "from './docParser'");
  contains('契约 · resumeParser 的 doc 分支走本地解析', resumeParser, 'extractDocText(buf)');
  notContains('契约 · resumeParser 不再直接拒绝 .doc', resumeParser, '暂不支持旧版 .doc');
  contains('契约 · doc 解析失败给转档提示', resumeParser, '另存为');

  const resumePage = read('src/pages/Resume.tsx');
  contains('契约 · 简历中心 accept 含 .doc', resumePage, 'accept=".pdf,.docx,.doc,.txt,.md,.text"');
  contains('契约 · 解析方式标签含 doc-local', resumePage, "'doc-local'");

  const mainCjs = read('electron/main.cjs');
  contains('契约 · 补充材料白名单含 doc', mainCjs, "['pdf', 'docx', 'doc', 'md', 'markdown', 'txt', 'text']");

  const bridge = read('bridge/server.cjs');
  contains('契约 · 桥接有 .doc 分支', bridge, 'parseResumeDoc');
  contains('契约 · 桥接优先 soffice 转档', bridge, 'doc-soffice');
  contains('契约 · 桥接兜底 Word COM 转档', bridge, 'doc-word-com');
}

cleanup();

// ===== 汇总 =====
const total = pass + failures.length;
console.log(`\n[doc-parse-regression] ${pass}/${total} 项通过`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部通过：.doc（OLE2 / RTF / HTML）解析链路无回归\n');
