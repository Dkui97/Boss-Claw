#!/usr/bin/env node
'use strict';
// OpenClaw 本地桥接服务（Node 跨平台版）
// 提供：状态、日报、控制（start/pause/stop/restore）、简历解析兜底（PDF→pdftotext、DOCX/旧版 DOC→mammoth/转档）
// 移植并适配自 job-claw-main\旧版本\学习逻辑\desktop-bridge\server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const { execFile, execFileSync } = require('child_process');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const dataDir = path.join(os.homedir(), '.bossclaw');
const databasePath = path.join(dataDir, 'data.json');
fs.mkdirSync(dataDir, { recursive: true });

function emptyDatabase() {
  return { events: [], commands: [], snapshots: [], control: { running: false, paused: false } };
}
function loadDatabase() {
  try {
    return { ...emptyDatabase(), ...JSON.parse(fs.readFileSync(databasePath, 'utf8')) };
  } catch {
    return emptyDatabase();
  }
}
function saveDatabase(database) {
  const tmp = `${databasePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(database, null, 2));
  fs.renameSync(tmp, databasePath);
}
function buildReport(database) {
  const today = new Date().toLocaleDateString('zh-CN');
  const events = database.events.filter((e) => new Date(e.ts).toLocaleDateString('zh-CN') === today);
  const sent = events.filter((e) => e.message === '投递成功');
  const failed = events.filter((e) => e.message === '投递失败');
  const analyzed = events.filter((e) => String(e.message || '').startsWith('岗位分析完成'));
  const lines = sent.slice(0, 30).map((e) => `- ${e.data?.job?.title || '岗位'}${e.data?.job?.company ? ` · ${e.data.job.company}` : ''}`);
  return [
    `BossClaw 求职日报｜${today}`, '', `成功沟通：${sent.length}`, `沟通失败：${failed.length}`,
    `岗位分析：${analyzed.length}`, `运行事件：${events.length}`, '',
    ...(lines.length ? lines : ['- 暂无成功沟通记录']), '', 'ByChris',
  ].join('\n');
}
function commandExists(command) {
  try { execFileSync(process.platform === 'win32' ? 'where' : '/usr/bin/which', [command], { stdio: 'ignore' }); return true; } catch { return false; }
}
function runFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: options.timeout || 30000, maxBuffer: options.maxBuffer || 12 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); } else resolve({ stdout, stderr });
    });
  });
}
function normalizeResumeText(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/^\(null\)$/gm, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function readableResumeText(text) {
  const compact = String(text || '').replace(/\s/g, '');
  if (compact.length < 40) return false;
  const readable = (compact.match(/[\u3400-\u9fffA-Za-z0-9]/g) || []).length;
  const bad = (compact.match(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g) || []).length;
  const hints = (String(text).match(/简历|教育|经历|项目|技能|电话|邮箱|GitHub|工作|实习|resume|education|experience|skills/gi) || []).length;
  return (readable - bad) / compact.length >= 0.5 && (hints > 0 || compact.length >= 220);
}
function decodeDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/s);
  if (!match) throw new Error('简历文件数据格式无效');
  return Buffer.from(match[2], 'base64');
}
async function parseResumePdf(payload) {
  const bytes = decodeDataUrl(payload.dataUrl);
  if (!bytes.length || bytes.length > 18 * 1024 * 1024) throw new Error('PDF 文件大小无效');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bossclaw-resume-'));
  const filePath = path.join(tempDir, 'resume.pdf');
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  const candidates = [];
  const diagnostics = [];
  const record = (method, ok, detail = '') => diagnostics.push({ method, ok, detail: String(detail || '').slice(0, 240) });
  try {
    if (commandExists('pdftotext')) {
      try {
        const { stdout } = await runFile('pdftotext', ['-layout', '-enc', 'UTF-8', filePath, '-'], { timeout: 50000 });
        const text = normalizeResumeText(stdout);
        const ok = readableResumeText(text);
        record('pdftotext', ok, ok ? `${text.length} 字` : '无可靠正文');
        if (ok) candidates.push({ ok: true, text, method: 'pdftotext' });
      } catch (error) { record('pdftotext', false, error.message); }
    } else record('pdftotext', false, '未安装');

    if (!candidates.length) return { ok: false, text: '', method: 'none', error: '本机解析与 OCR 均未识别到可靠正文（可安装 poppler 的 pdftotext 或改用 DOCX/TXT）', diagnostics };
    candidates.sort((a, b) => b.text.length - a.text.length);
    return { ...candidates[0], diagnostics };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function parseResumeDoc(payload) {
  const bytes = decodeDataUrl(payload.dataUrl);
  if (!bytes.length || bytes.length > 18 * 1024 * 1024) throw new Error('.doc 文件大小无效');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bossclaw-resume-doc-'));
  const filePath = path.join(tempDir, 'resume.doc');
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  const diagnostics = [];
  const record = (method, ok, detail = '') => diagnostics.push({ method, ok, detail: String(detail || '').slice(0, 240) });
  try {
    const converted = await convertDocToDocx(filePath, tempDir, record);
    if (!converted) {
      return {
        ok: false, text: '', method: 'none',
        error: '本机未找到可用的 .doc 转档器（需装 Microsoft Word 或 LibreOffice）；请在 Word 中「另存为」DOCX/PDF/TXT 后重新导入，或直接复制粘贴正文',
        diagnostics,
      };
    }
    try {
      const mammoth = require('mammoth');
      const { value } = await mammoth.extractRawText({ buffer: fs.readFileSync(converted.path) });
      const text = normalizeResumeText(value);
      const ok = readableResumeText(text);
      record('mammoth', ok, ok ? `${text.length} 字` : '无可靠正文');
      if (ok) return { ok: true, text, method: converted.method, diagnostics };
    } catch (error) {
      record('mammoth', false, error.message);
    }
    return { ok: false, text: '', method: 'none', error: 'DOC 已转档但未提取到可靠正文，请改用 DOCX/PDF 或直接粘贴正文', diagnostics };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function findSoffice() {
  return ['soffice', 'libreoffice', 'soffice.exe'].find((cmd) => commandExists(cmd)) || '';
}

/** 旧版 .doc → .docx 转档：先试 LibreOffice（跨平台），再试 Windows + Word COM（需装 Office） */
async function convertDocToDocx(filePath, tempDir, record) {
  const outDir = path.join(tempDir, 'conv');
  fs.mkdirSync(outDir, { recursive: true });
  const expected = path.join(outDir, `${path.basename(filePath).replace(/\.doc$/i, '')}.docx`);

  const soffice = findSoffice();
  if (soffice) {
    try {
      await runFile(soffice, ['--headless', '--norestore', '--convert-to', 'docx', '--outdir', outDir, filePath], { timeout: 90000 });
      if (fs.existsSync(expected)) {
        record('soffice', true, '转档成功');
        return { path: expected, method: 'doc-soffice' };
      }
      record('soffice', false, '未产出 docx');
    } catch (error) {
      record('soffice', false, error.message);
    }
  } else {
    record('soffice', false, '未安装');
  }

  if (process.platform === 'win32') {
    // 路径经 base64 传入，规避中文路径与引号在命令行中的转义问题（-EncodedCommand 同样为编码传递）
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    const script = [
      "$ErrorActionPreference='Stop'",
      `$src=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(filePath)}'))`,
      `$dst=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(expected)}'))`,
      '$w=New-Object -ComObject Word.Application',
      '$w.Visible=$false',
      '$w.DisplayAlerts=0',
      'try{$d=$w.Documents.Open($src,$false,$true,$false);$d.SaveAs2($dst,12);$d.Close(0)}finally{$w.Quit()}',
    ].join(';');
    try {
      await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 90000 });
      if (fs.existsSync(expected)) {
        record('word-com', true, '转档成功');
        return { path: expected, method: 'doc-word-com' };
      }
      record('word-com', false, '未产出 docx');
    } catch (error) {
      record('word-com', false, error.message);
    }
  } else {
    record('word-com', false, '仅 Windows 可用');
  }
  return null;
}

async function parseResumeText(payload) {
  if (!payload || !payload.dataUrl) throw new Error('缺少简历数据');
  const name = String(payload.name || '').toLowerCase();
  const isTxt = name.endsWith('.txt') || name.endsWith('.md');
  const isDocx = name.endsWith('.docx');
  const isDoc = name.endsWith('.doc');
  if (isTxt) {
    const text = normalizeResumeText(decodeDataUrl(payload.dataUrl).toString('utf8'));
    return { ok: readableResumeText(text), text, method: 'text' };
  }
  if (isDocx) {
    try {
      const mammoth = require('mammoth');
      const buffer = decodeDataUrl(payload.dataUrl);
      const { value } = await mammoth.extractRawText({ buffer });
      const text = normalizeResumeText(value);
      return { ok: readableResumeText(text), text, method: 'mammoth' };
    } catch (error) {
      return { ok: false, text: '', method: 'none', error: `DOCX 解析失败（需安装 mammoth 或改用 PDF/TXT）：${error.message}` };
    }
  }
  if (isDoc) {
    try {
      return await parseResumeDoc(payload);
    } catch (error) {
      return { ok: false, text: '', method: 'none', error: `DOC 解析失败（可改用 DOCX/PDF/TXT）：${error.message}` };
    }
  }
  return parseResumePdf(payload);
}

function respond(response, status, payload, origin) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin || 'null',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://127.0.0.1:${config.port}`);
  const origin = request.headers.origin || '';
  const token = requestUrl.searchParams.get('token') || '';
  if (request.method === 'OPTIONS') return respond(response, 200, {}, origin);
  if (token !== config.token) return respond(response, 403, { ok: false, error: 'token denied' }, origin);

  let body = '';
  let tooLarge = false;
  request.on('data', (chunk) => { body += chunk; if (body.length > 28 * 1024 * 1024) tooLarge = true; });
  request.on('end', async () => {
    if (tooLarge) return respond(response, 413, { ok: false, error: 'request too large' }, origin);
    try {
      const database = loadDatabase();
      const payload = body ? JSON.parse(body) : {};
      if (requestUrl.pathname === '/status') {
        return respond(response, 200, {
          ok: true, name: 'bossclaw-bridge', version: '2.0.0', running: database.control.running, paused: database.control.paused,
          parsers: { pdftotext: commandExists('pdftotext'), soffice: findSoffice() || false, wordCom: process.platform === 'win32' },
          databasePath, events: database.events.length,
        }, origin);
      }
      if (requestUrl.pathname === '/logs') {
        // 桥接日志查看：最近的指令与事件（时间倒序，各最多 50 条）
        const commands = (database.commands || []).slice(-50).reverse();
        const events = (database.events || []).slice(-50).reverse();
        return respond(response, 200, { ok: true, commands, events }, origin);
      }
      if (requestUrl.pathname === '/report') {
        return respond(response, 200, { ok: true, report: buildReport(database) }, origin);
      }
      if (requestUrl.pathname === '/command') {
        const type = String(payload.type || 'status');
        if (type === 'start') { database.control.running = true; database.control.paused = false; }
        else if (type === 'pause') { database.control.paused = true; }
        else if (type === 'stop') { database.control.running = false; database.control.paused = false; }
        else if (type === 'restore') {
          const snapshot = database.snapshots.at(-1);
          return respond(response, 200, { ok: true, snapshot: snapshot || null }, origin);
        }
        database.commands.push({ type, ts: Date.now() });
        saveDatabase(database);
        return respond(response, 200, { ok: true, control: database.control }, origin);
      }
      if (requestUrl.pathname === '/ocr') {
        try {
          const result = await parseResumePdf(payload);
          return respond(response, 200, result, origin);
        } catch (error) {
          return respond(response, 200, { ok: false, error: error.message }, origin);
        }
      }
      if (requestUrl.pathname === '/resume-text') {
        try {
          const result = await parseResumeText(payload);
          return respond(response, 200, result, origin);
        } catch (error) {
          return respond(response, 200, { ok: false, error: error.message }, origin);
        }
      }
      return respond(response, 404, { ok: false, error: 'not found' }, origin);
    } catch (error) {
      return respond(response, 500, { ok: false, error: error.message }, origin);
    }
  });
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`[OpenClaw bridge] listening on 127.0.0.1:${config.port}`);
});
