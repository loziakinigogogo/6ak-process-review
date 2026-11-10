'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { install, inventory, fetchRelease, readRelease } = require('./install.cjs');
const { pack } = require('./pack.cjs');

function temporaryProject(t) {
  const temporaryParent = fs.realpathSync(os.tmpdir());
  const project = fs.mkdtempSync(path.join(temporaryParent, '6ak-process-review-install-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(project)), temporaryParent);
    assert.ok(path.basename(project).startsWith('6ak-process-review-install-'));
    fs.rmSync(project, { recursive: true, force: true });
  });
  return project;
}

test('project installation is self-contained, repeatable and protects local changes', t => {
  const project = temporaryProject(t);
  const installed = install(project);
  assert.equal(installed.status, 'installed');
  assert.deepEqual(inventory(installed.target), inventory(path.resolve(__dirname, '../skills/6ak-process-review')));
  assert.equal(install(project).status, 'unchanged');
  const extra = path.join(installed.target, 'local-notes.md');
  fs.writeFileSync(extra, 'Keep my notes');
  assert.throws(() => install(project), /本地修改/);
  assert.equal(fs.readFileSync(extra, 'utf8'), 'Keep my notes');
  fs.unlinkSync(extra);
  const receiptPath = path.join(installed.target, '.installation.json');
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  receipt.version = '0.0.0';
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  const upgraded = install(project);
  assert.equal(upgraded.status, 'installed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(upgraded.previousDirectory, '.installation.json'))).version, '0.0.0');
  assert.deepEqual(inventory(upgraded.target), inventory(upgraded.previousDirectory));
  const entry = path.join(upgraded.target, 'SKILL.md');
  fs.appendFileSync(entry, '\nUser edit');
  assert.throws(() => install(project), /本地修改/);
  assert.ok(fs.readFileSync(entry, 'utf8').endsWith('User edit'));
});

test('a standalone updater installs an offline package over an existing managed copy', t => {
  const root = temporaryProject(t);
  const project = path.join(root, '独立业务项目');
  fs.mkdirSync(project);
  const previous = install(project);
  const history = path.join(project, '.document-review');
  fs.mkdirSync(history);
  const original = path.join(history, 'keep.txt');
  fs.writeFileSync(original, 'Business history');
  const updater = path.join(project, 'update-skill.cjs');
  fs.copyFileSync(path.join(__dirname, 'install.cjs'), updater);
  const { output, version, sha256 } = pack(root);
  const run = () => JSON.parse(execFileSync(process.execPath, [updater, '--from', output], { cwd: project, encoding: 'utf8' }));

  const installed = run();
  assert.equal(installed.status, 'installed');
  assert.equal(installed.version, version);
  assert.equal(installed.target, previous.target);
  assert.deepEqual(inventory(installed.target), inventory(installed.previousDirectory));
  assert.equal(fs.readFileSync(original, 'utf8'), 'Business history');
  const receipt = JSON.parse(fs.readFileSync(path.join(installed.target, '.installation.json'), 'utf8'));
  assert.deepEqual(receipt.release, { tag: `v${version}`, sha256 });
  assert.equal(run().status, 'unchanged');
});

test('GitHub updates verify the requested version and the published ZIP digest', async t => {
  const { output, version, sha256 } = pack(temporaryProject(t));
  const archive = fs.readFileSync(output);
  assert.throws(() => readRelease(archive, 'v0.0.0'), /版本与请求/);
  const tag = `v${version}`;
  const name = path.basename(output);
  const repo = 'loziakinigogogo/6ak-process-review';
  let digest = sha256;
  t.mock.method(globalThis, 'fetch', async url => {
    if (url === `https://api.github.com/repos/${repo}/releases/tags/${tag}`) {
      return Response.json({ tag_name: tag, assets: [{ name, size: archive.length, digest: `sha256:${digest}` }] });
    }
    assert.equal(url, `https://github.com/${repo}/releases/download/${tag}/${name}`);
    return new Response(archive);
  });
  const release = await fetchRelease(version);
  assert.deepEqual(release.source, { tag, sha256, repository: repo });
  digest = '0'.repeat(64);
  await assert.rejects(fetchRelease(version), /SHA-256 校验失败/);
});
