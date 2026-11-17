'use strict';

// Keep the notices of the browser's runtime dependencies with the installed UI.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const visited = new Map();
function collect(name, from) {
  if (name.startsWith('@types/')) return;
  const resolve = createRequire(path.join(from, 'package.json'));
  let directory = path.dirname(resolve.resolve(name));
  let metadata;
  while (directory !== path.dirname(directory)) {
    const file = path.join(directory, 'package.json');
    if (fs.existsSync(file)) {
      const candidate = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (candidate.name === name) { metadata = candidate; break; }
    }
    directory = path.dirname(directory);
  }
  if (!metadata) throw new Error('Cannot locate dependency metadata: ' + name);
  const key = `${name}@${metadata.version}`;
  if (visited.has(key)) return;
  const licenses = fs.readdirSync(directory).filter(file => /^(licen[sc]e|copying|notice)(\.|$)/i.test(file) && fs.statSync(path.join(directory, file)).isFile());
  if (!licenses.length) throw new Error('Missing distributed license: ' + key);
  const repository = typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url;
  visited.set(key, { metadata, repository, licenses: licenses.map(file => ({ file, text: fs.readFileSync(path.join(directory, file), 'utf8') })) });
  for (const dependency of Object.keys(metadata.dependencies || {}).sort()) collect(dependency, directory);
}
for (const name of ['react', 'react-dom', '@xyflow/react', '@tisoap/react-flow-smart-edge', 'elkjs', 'lucide-react']) collect(name, root);
const sections = ['# Workbench third-party notices', '',
  'The bundled browser UI contains the following upstream packages. Package versions are locked by the maintenance repository. License notices are reproduced without alteration below.', '',
  'ELK is distributed under the Eclipse Public License 2.0 option. Its upstream source is available from https://github.com/kieler/elkjs and https://github.com/eclipse-elk/elk. This project does not modify the ELK algorithm source.', ''];
for (const [key, item] of [...visited].sort(([a], [b]) => a.localeCompare(b))) {
  sections.push(`## ${key}`, '', `License metadata: ${item.metadata.license || 'See license text'}`, '');
  if (item.repository) sections.push(`Upstream: ${item.repository}`, '');
  for (const license of item.licenses) sections.push(`### ${license.file}`, '', license.text.trimEnd(), '');
}
const output = path.join(root, 'skills/6ak-process-review/workbench/THIRD_PARTY_NOTICES.md');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, sections.join('\n') + '\n');
console.log(`Wrote runtime notices for ${visited.size} package versions.`);
