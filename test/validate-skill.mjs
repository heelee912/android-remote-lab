import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = path.join(root, 'skills', 'android-remote-device-lab');
const markdown = fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8');
const metadata = fs.readFileSync(path.join(skill, 'agents', 'openai.yaml'), 'utf8');
const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);

assert.ok(frontmatter, 'SKILL.md frontmatter is required');
const fields = frontmatter[1].split(/\r?\n/).filter(Boolean).map((line) => line.split(':', 1)[0]);
assert.deepEqual(fields, ['name', 'description']);
assert.match(frontmatter[1], /^name: android-remote-device-lab$/m);
assert.doesNotMatch(markdown, /\bTODO\b/);
assert.match(metadata, /default_prompt:.*\$android-remote-device-lab/);
assert.ok(fs.existsSync(path.join(skill, 'scripts', 'run-smoke.ps1')));
assert.ok(fs.existsSync(path.join(skill, 'references', 'contract.md')));
process.stdout.write('skill validation: PASS\n');
