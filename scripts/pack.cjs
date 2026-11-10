'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { inventory, readRelease, skillName, bundleName, versionPattern } = require('./install.cjs');

function pack(outputDirectory) {
  const { version } = require('../package.json');
  if (!versionPattern.test(version)) throw new Error('package.json 必须指定正式发布版本。');
  const root = path.join(__dirname, '..', 'skills', skillName);
  const output = path.resolve(outputDirectory, `${skillName}-v${version}.zip`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${skillName}-pack-`));
  const archive = path.join(directory, 'release.zip');
  const manifest = path.join(directory, bundleName);
  try {
    const files = Object.fromEntries(Object.keys(inventory(root)).map(name =>
      [name, fs.readFileSync(path.join(root, name)).toString('base64')]));
    fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, name: skillName, version, files }), { flag: 'wx' });
    if (process.platform === 'win32') execFileSync('tar.exe', ['-a', '-cf', archive, bundleName], { cwd: directory });
    else execFileSync('zip', ['-q', archive, bundleName], { cwd: directory });
    const release = readRelease(fs.readFileSync(archive), `v${version}`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(archive, output, fs.constants.COPYFILE_EXCL);
    return { output, version, sha256: release.source.sha256 };
  } finally {
    for (const file of [manifest, archive]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
}

module.exports = { pack };
if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('用法 node scripts/pack.cjs <发布包输出目录>');
    console.log(JSON.stringify(pack(process.argv[2]), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
