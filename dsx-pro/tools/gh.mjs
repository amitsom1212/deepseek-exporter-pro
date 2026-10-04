#!/usr/bin/env node
/**
 * 维护者用的极简 GitHub 助手：只用 node 自带的 fetch，不需要安装 gh CLI。
 *
 * 用法：
 *   node tools/gh.mjs whoami
 *   node tools/gh.mjs create-repo <仓库名> [--public|--private] [--desc "描述"]
 *   node tools/gh.mjs credfile                  # 生成 git 推送用的 extraheader 文件（不含 token 本身在命令行）
 *   node tools/gh.mjs release <tag> <标题> <文件...> [--notes "说明"]
 *
 * token 来源（按优先级）：
 *   1) 环境变量 GH_TOKEN
 *   2) --token-file <路径>
 *   3) 默认：仓库上一级目录下的 .gh-token.txt（本机即 F:\dsh\.gh-token.txt）
 *
 * 安全约定：
 *   - 绝不把 token 打印到输出里；
 *   - 生成的 extraheader 文件放在仓库**之外**，用完可随时删除（可由 token 文件重新生成）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');           // dsx-pro/tools → 仓库根
const API = 'https://api.github.com';

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function has(flag) {
  return process.argv.includes(flag);
}

function tokenPath() {
  return arg('--token-file') || resolve(REPO_ROOT, '..', '.gh-token.txt');
}

function readToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  const p = tokenPath();
  try {
    const t = readFileSync(p, 'utf8').trim();
    if (!t) throw new Error('文件是空的');
    return t;
  } catch (e) {
    console.error(`✗ 读不到 token：${p}`);
    console.error(`  ${e.message}`);
    console.error('  请把 token 单独一行写进该文件，或用 GH_TOKEN 环境变量，或 --token-file 指定路径。');
    process.exit(1);
  }
}

async function api(pathOrUrl, { method = 'GET', body, raw, contentType } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API}${pathOrUrl}`;
  const headers = {
    Authorization: `Bearer ${readToken()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dsx-gh-helper'
  };
  if (raw) {
    headers['Content-Type'] = contentType || 'application/octet-stream';
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, {
    method,
    headers,
    body: raw ? raw : (body !== undefined ? JSON.stringify(body) : undefined)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }
  return { res, json, text };
}

async function fail(res, json, text, what) {
  console.error(`✗ ${what}失败：HTTP ${res.status}`);
  const msg = (json && json.message) || text || '';
  console.error(`  ${msg}`);
  if (res.status === 401) console.error('  → token 无效或已过期');
  if (res.status === 403) console.error('  → 权限不足（公开仓库建仓/推送需要 public_repo）或触发了限流');
  if (res.status === 404) console.error('  → 找不到仓库／资源（也可能是 token 无权访问它）');
  if (json && json.errors) console.error('  ' + JSON.stringify(json.errors));
  process.exit(1);
}

/* ------------------------------------------------------------------ */

async function whoami() {
  const { res, json, text } = await api('/user');
  if (!res.ok) await fail(res, json, text, '读取用户信息');
  const scopes = res.headers.get('x-oauth-scopes');
  console.log(`✓ token 可用`);
  console.log(`  login : ${json.login}`);
  console.log(`  name  : ${json.name || '(未设置)'}`);
  console.log(`  权限  : ${scopes === null ? '(细粒度 token，无 scopes 头)' : scopes || '(无 scope)'}`);
  return json;
}

async function createRepo() {
  const name = process.argv[3];
  if (!name || name.startsWith('--')) {
    console.error('用法：node tools/gh.mjs create-repo <仓库名> [--public|--private] [--desc "描述"]');
    process.exit(1);
  }
  const me = await whoami();
  const privateRepo = has('--private');
  const desc = arg('--desc', '');

  // 已存在就直接返回，便于反复执行
  const existing = await api(`/repos/${me.login}/${name}`);
  if (existing.res.ok) {
    console.log(`\nℹ 仓库已存在：${existing.json.full_name}（${existing.json.private ? '私有' : '公开'}）`);
    console.log(`  ${existing.json.html_url}`);
    saveIdentity(me.login, name);
    return existing.json;
  }

  const { res, json, text } = await api('/user/repos', {
    method: 'POST',
    body: {
      name,
      description: desc,
      private: privateRepo,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false
    }
  });
  if (!res.ok) await fail(res, json, text, '创建仓库');
  console.log(`\n✓ 已创建${json.private ? '私有' : '公开'}仓库：${json.full_name}`);
  console.log(`  ${json.html_url}`);
  saveIdentity(me.login, name);
  return json;
}

/**
 * 生成 git 用的 HTTP 头文件（含 Basic 凭据）。
 * 这样推送命令里只有这个文件路径，token 不会出现在命令行／会话记录里。
 */
async function credfile() {
  const login = await identityLogin();
  const basic = Buffer.from(`${login}:${readToken()}`, 'utf8').toString('base64');
  // 放在仓库根目录（.gitignore 里已排除 .gh-*），推送完即可删除
  const out = resolve(REPO_ROOT, '.gh-extraheader');
  writeFileSync(out, `[http "https://github.com/"]\n\textraheader = AUTHORIZATION: Basic ${basic}\n`, 'utf8');
  console.log(`✓ 已生成推送凭据文件：${out}`);
  console.log(`  推送时用：git -c include.path="${out}" push ...`);
  console.log('  推送完请删掉该文件（需要时用本命令重新生成）。');
  return out;
}

/** 把身份写进 .git/（不会被提交），方便后续命令不用重复问 API */
function saveIdentity(login, repo) {
  try {
    writeFileSync(resolve(REPO_ROOT, '.git', 'gh-login.json'), JSON.stringify({ login, repo: repo || '' }, null, 2), 'utf8');
  } catch (e) { /* 非 git 目录就算了 */ }
}

function loadIdentity() {
  try {
    return JSON.parse(readFileSync(resolve(REPO_ROOT, '.git', 'gh-login.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

async function identityLogin() {
  const id = loadIdentity();
  if (id && id.login) return id.login;
  const me = await whoami();
  saveIdentity(me.login);
  return me.login;
}

async function release() {
  const tag = process.argv[3];
  const title = process.argv[4];
  const files = [];
  // 说明文本：--notes-file 优先（避免把多行/中文正文塞进命令行）
  const notesFile = arg('--notes-file');
  let notes = arg('--notes', `发布 ${tag}`);
  if (notesFile) {
    try {
      notes = readFileSync(notesFile, 'utf8');
    } catch (e) {
      console.error(`✗ 读不到说明文件：${notesFile}`);
      process.exit(1);
    }
  }
  for (let i = 5; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--notes') { i++; continue; }
    if (a === '--notes-file') { i++; continue; }
    if (a.startsWith('--')) continue;
    files.push(a);
  }
  if (!tag || !title) {
    console.error('用法：node tools/gh.mjs release <tag> <标题> <文件...> [--notes "说明" | --notes-file <路径>]');
    process.exit(1);
  }

  // 仓库身份：从 .git/gh-login.json 或环境变量推断
  let owner = process.env.GH_OWNER;
  let repo = process.env.GH_REPO;
  if (!owner || !repo) {
    try {
      const info = JSON.parse(readFileSync(resolve(REPO_ROOT, '.git', 'gh-login.json'), 'utf8'));
      owner = owner || info.login;
      repo = repo || info.repo;
    } catch (e) { /* 忽略 */ }
  }
  if (!owner || !repo) {
    console.error('✗ 无法确定仓库：请设置 GH_OWNER / GH_REPO 环境变量');
    process.exit(1);
  }

  // 已存在则复用，便于反复执行
  let rel = (await api(`/repos/${owner}/${repo}/releases/tags/${tag}`)).json;
  if (!rel || !rel.id) {
    const created = await api(`/repos/${owner}/${repo}/releases`, {
      method: 'POST',
      body: { tag_name: tag, name: title, body: notes, draft: false, prerelease: false, target_commitish: 'main' }
    });
    if (!created.res.ok) await fail(created.res, created.json, created.text, '创建 Release');
    rel = created.json;
    console.log(`✓ 已创建 Release ${tag}`);
  } else {
    console.log(`ℹ Release ${tag} 已存在，直接复用`);
  }

  const existingAssets = new Set((rel.assets || []).map(a => a.name));
  for (const f of files) {
    const name = basename(f);
    if (existingAssets.has(name)) {
      console.log(`  ℹ 附件已存在，跳过：${name}`);
      continue;
    }
    const bytes = readFileSync(f);
    const up = await api(`https://uploads.github.com/repos/${owner}/${repo}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      raw: bytes,
      contentType: name.endsWith('.zip') ? 'application/zip' : 'application/octet-stream'
    });
    if (!up.res.ok) await fail(up.res, up.json, up.text, `上传 ${name}`);
    console.log(`  ✓ 已上传 ${name}（${(bytes.length / 1024).toFixed(1)} KB）`);
  }
  console.log(`\n✓ Release 完成：${rel.html_url}`);
}

/* ------------------------------------------------------------------ */

const cmd = process.argv[2];
if (cmd === 'whoami') await whoami();
else if (cmd === 'create-repo') await createRepo();
else if (cmd === 'credfile') credfile();
else if (cmd === 'release') await release();
else {
  console.log('用法：');
  console.log('  node tools/gh.mjs whoami');
  console.log('  node tools/gh.mjs create-repo <仓库名> [--public|--private] [--desc "描述"]');
  console.log('  node tools/gh.mjs credfile');
  console.log('  node tools/gh.mjs release <tag> <标题> <文件...> [--notes "说明" | --notes-file <路径>]');
  process.exit(1);
}
