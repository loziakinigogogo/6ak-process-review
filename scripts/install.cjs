#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const sourceRoot = path.resolve(__dirname, '..');
const skillRoot = path.join(sourceRoot, 'skills', '6ak-process-review');
const skillName = '6ak-process-review';
const repository = 'loziakinigogogo/6ak-process-review';
const bundleName = 'skill-bundle.json';
const receiptName = '.installation.json';
const maxArchiveBytes = 16 * 1024 * 1024;
const versionPattern = /^\d+\.\d+\.\d+$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function inventory(root, relative = '') {
  const files = {};
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = relative ? relative + '/' + entry.name : entry.name;
    if (name === receiptName) continue;
    const file = path.join(root, name);
    if (entry.isDirectory()) Object.assign(files, inventory(root, name));
    else if (entry.isFile()) files[name] = sha256(fs.readFileSync(file));
    else throw new Error('安装目录包含链接或特殊文件 ' + file);
  }
  return files;
}

function plainDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('需要普通目录 ' + directory);
}

function install(projectDirectory, release) {
  const projectRoot = fs.realpathSync(projectDirectory);
  plainDirectory(projectRoot);
  let parent = projectRoot;
  for (const name of ['.agents', 'skills']) {
    parent = path.join(parent, name);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent);
    plainDirectory(parent);
  }
  const target = path.join(parent, skillName);
  if (target === skillRoot) throw new Error('安装位置与维护源相同');
  const lock = path.join(projectRoot, '.agents', '.6ak-process-review-install.lock');
  const lockFile = fs.openSync(lock, 'wx');
  let staging;
  try {
    const { version } = release ?? JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
    const files = release?.files ?? inventory(skillRoot);
    const source = release ? { release: release.source } : { sourceDirectory: sourceRoot };
    const receipt = { schemaVersion: 1, name: skillName, version, ...source, files };
    if (fs.existsSync(target)) {
      plainDirectory(target);
      const receiptFile = path.join(target, receiptName);
      if (!fs.lstatSync(receiptFile).isFile() || fs.lstatSync(receiptFile).isSymbolicLink()) throw new Error('安装记录必须是普通文件');
      const previous = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      if (previous.schemaVersion !== 1 || previous.name !== skillName || !isDeepStrictEqual(inventory(target), previous.files)) {
        throw new Error('已安装副本有本地修改或缺少有效安装记录，请先保留并核对 ' + target);
      }
      if (isDeepStrictEqual(previous, receipt)) return { status: 'unchanged', target, version };
    }
    staging = fs.mkdtempSync(path.join(projectRoot, '.agents', '.6ak-process-review-install-'));
    if (release) {
      for (const [name, bytes] of release.entries) {
        const file = path.join(staging, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes, { flag: 'wx' });
      }
    } else {
      fs.cpSync(skillRoot, staging, { recursive: true, dereference: false });
    }
    if (!isDeepStrictEqual(inventory(staging), files)) throw new Error('复制期间维护源发生变化，请重试');
    fs.writeFileSync(path.join(staging, receiptName), JSON.stringify(receipt, null, 2) + '\n');
    let previousDirectory;
    if (fs.existsSync(target)) {
      previousDirectory = path.join(projectRoot, '.agents', '.6ak-process-review-previous-' + randomUUID());
      fs.renameSync(target, previousDirectory);
    }
    try {
      fs.renameSync(staging, target);
      staging = undefined;
    } catch (error) {
      if (previousDirectory) fs.renameSync(previousDirectory, target);
      throw error;
    }
    return { status: 'installed', target, version, previousDirectory };
  } finally {
    fs.closeSync(lockFile);
    fs.unlinkSync(lock);
    // Failed staging is retained for inspection, including its exact path.
    if (staging) console.error('未完成的安装副本保留在 ' + staging);
  }
}

function readRelease(archive, publishedTag) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${skillName}-release-`));
  const file = path.join(directory, 'release.zip');
  let bundle;
  try {
    fs.writeFileSync(file, archive, { flag: 'wx' });
    // Read just the data entry. The archiver never creates paths from the ZIP.
    const options = { encoding: 'utf8', maxBuffer: maxArchiveBytes, stdio: ['ignore', 'pipe', 'pipe'] };
    const text = process.platform === 'win32'
      ? execFileSync('tar.exe', ['-xOf', file, bundleName], options)
      : execFileSync('unzip', ['-p', file, bundleName], options);
    bundle = JSON.parse(text);
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
  if (bundle?.schemaVersion !== 1 || bundle.name !== skillName ||
      typeof bundle.version !== 'string' || !versionPattern.test(bundle.version) ||
      !bundle.files || typeof bundle.files !== 'object' || Array.isArray(bundle.files) ||
      !Object.hasOwn(bundle.files, 'SKILL.md')) {
    throw new Error('发布包格式无效。');
  }
  const tag = `v${bundle.version}`;
  if (publishedTag && publishedTag !== tag) throw new Error('发布包版本与请求的 GitHub 标签不一致。');
  const seen = new Set();
  const entries = Object.entries(bundle.files).map(([name, base64]) => {
    const lowerName = name.toLowerCase();
    if (seen.has(lowerName) || name.split('/').some(part =>
      !/^[A-Za-z0-9_.-]+$/.test(part) || part.endsWith('.') || part.toLowerCase() === receiptName ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
      throw new Error('发布包包含不安全或重复的文件名：' + name);
    }
    seen.add(lowerName);
    if (typeof base64 !== 'string') throw new Error('发布包包含无效的文件内容：' + name);
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.toString('base64') !== base64) throw new Error('发布包包含无效的文件编码：' + name);
    return [name, bytes];
  });
  for (const name of seen) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (seen.has(parts.slice(0, i).join('/'))) throw new Error('发布包的文件与目录冲突：' + name);
    }
  }
  const source = { tag, sha256: sha256(archive), ...(publishedTag ? { repository } : {}) };
  return { version: bundle.version, source, entries, files: Object.fromEntries(entries.map(([name, bytes]) => [name, sha256(bytes)])) };
}

async function fetchRelease(version) {
  if (!versionPattern.test(version)) throw new Error('请指定发布版本，例如 0.1.3。');
  const tag = `v${version}`;
  const name = `${skillName}-${tag}.zip`;
  const signal = AbortSignal.timeout(30_000);
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, {
    signal, headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`读取 GitHub 发布 ${tag} 失败（HTTP ${response.status}）。`);
  const release = await response.json();
  const asset = release.assets?.find(item => item.name === name);
  if (release.tag_name !== tag || release.draft || release.prerelease || !asset ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maxArchiveBytes ||
      !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
    throw new Error('GitHub 发布缺少带 SHA-256 摘要的有效发布包：' + name);
  }
  const download = await fetch(`https://github.com/${repository}/releases/download/${tag}/${name}`, { signal });
  if (!download.ok) throw new Error(`下载 ${name} 失败（HTTP ${download.status}）。`);
  const chunks = [];
  let size = 0;
  for await (const chunk of download.body) {
    size += chunk.length;
    if (size > asset.size) throw new Error('下载内容超出发布包大小。');
    chunks.push(chunk);
  }
  const archive = Buffer.concat(chunks);
  if (size !== asset.size || `sha256:${sha256(archive)}` !== asset.digest) throw new Error('发布包大小或 SHA-256 校验失败。');
  return readRelease(archive, tag);
}

async function main(args) {
  const project = args[0]?.startsWith('--') ? process.cwd() : args.shift();
  const [mode, value] = args;
  let release;
  if (project && args.length === 2 && mode === '--version') {
    release = await fetchRelease(value);
  } else if (project && args.length === 2 && mode === '--from') {
    const size = fs.statSync(value).size;
    if (!size || size > maxArchiveBytes) throw new Error('发布包大小无效。');
    const archive = fs.readFileSync(value);
    if (archive.length !== size) throw new Error('读取期间发布包发生变化，请重试。');
    release = readRelease(archive);
  } else if (!project || args.length) {
    throw new Error('用法 node scripts/install.cjs [项目根目录] [--from 发布包.zip | --version 版本]');
  }
  console.log(JSON.stringify(install(project, release), null, 2));
}

module.exports = { install, inventory, readRelease, fetchRelease, skillName, bundleName, versionPattern, sha256 };
if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
