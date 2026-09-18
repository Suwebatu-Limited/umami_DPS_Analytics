#!/usr/bin/env node
/**
 * Fails the build if any source file carries a line long enough to be injected code,
 * or if .vscode/tasks.json carries an auto-run task or a task pointing at a file
 * whose real content does not match its extension.
 *
 * This repository has been hit repeatedly by the same family: one line appended to
 * a config file after the real export, padded with spaces so it sits off the right
 * edge of an editor, requiring http/zlib/child_process through hex escapes so a
 * string search finds nothing. A later variant used .vscode/tasks.json with a
 * runOn/folderOpen trigger pointing at a disguised binary instead. Neither variant
 * shares marker text with the other, which is why grepping for one missed the next.
 *
 * So this gates on shape rather than content. Injected payloads are minified into
 * a single enormous line; hand-written source is not. Nothing legitimate in here
 * comes close to the threshold - the largest real config has a longest line near
 * 380 characters.
 *
 * Runs as prebuild, so it blocks a deploy rather than only a pull request.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const ROOT = process.cwd();
const MAX_LINE = 2000;

const SKIP_DIRS = new Set([
  'node_modules', '.next', '.git', '.vercel', 'dist', 'build', 'coverage', 'out',
]);

const CHECK_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);

/** Minified and generated files are legitimately one long line. */
const skipFile = name =>
  name.includes('.min.') || name.endsWith('-lock.json') || name === 'package-lock.json';

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) yield* walk(full);
    } else if (CHECK_EXT.has(extname(entry)) && !skipFile(entry)) {
      yield full;
    }
  }
}

const findings = [];
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.length > MAX_LINE) {
      findings.push({ file: relative(ROOT, file), line: i + 1, length: line.length });
    }
  });
}

/** A handful of real binary signatures. A file claiming to be a font/image but
 * opening with none of these has been swapped for something else. */
const BINARY_MAGIC = [
  Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG
  Buffer.from([0xff, 0xd8, 0xff]), // JPEG
  Buffer.from('GIF8'),
  Buffer.from('OTTO'), // OpenType/CFF
  Buffer.from([0x00, 0x01, 0x00, 0x00]), // TrueType
  Buffer.from('wOFF'),
  Buffer.from('wOF2'),
  Buffer.from('%PDF'),
];
const CLAIMS_BINARY = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ttf', '.otf', '.woff', '.woff2', '.pdf', '.ico',
]);

const tasksPath = join(ROOT, '.vscode', 'tasks.json');
if (existsSync(tasksPath)) {
  let tasksJson;
  try {
    tasksJson = JSON.parse(readFileSync(tasksPath, 'utf8'));
  } catch {
    tasksJson = null;
  }
  for (const task of tasksJson?.tasks ?? []) {
    if (task.runOptions?.runOn === 'folderOpen') {
      findings.push({
        file: '.vscode/tasks.json',
        line: 0,
        length: 0,
        note: `task "${task.label ?? '(unlabeled)'}" auto-runs on folder open`,
      });
    }
    const referenced = [task.command, ...(Array.isArray(task.args) ? task.args : [])]
      .filter(v => typeof v === 'string')
      .flatMap(v => v.match(/[.\/\w-]+\.(png|jpg|jpeg|gif|webp|ttf|otf|woff2?|pdf|ico)/gi) ?? []);
    for (const ref of referenced) {
      const candidate = join(ROOT, ref.replace(/^\.\//, ''));
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      const ext = extname(candidate).toLowerCase();
      if (!CLAIMS_BINARY.has(ext)) continue;
      const head = readFileSync(candidate).subarray(0, 8);
      const matches = BINARY_MAGIC.some(magic => head.subarray(0, magic.length).equals(magic));
      if (!matches) {
        findings.push({
          file: relative(ROOT, candidate),
          line: 0,
          length: 0,
          note: `referenced by .vscode/tasks.json, claims ${ext} but its content is not that format`,
        });
      }
    }
  }
}

if (findings.length > 0) {
  console.error('\nInjected code check FAILED.\n');
  for (const f of findings) {
    if (f.note) {
      console.error(`  ${f.file}: ${f.note}`);
    } else {
      console.error(`  ${f.file}:${f.line} carries a ${f.length} character line`);
    }
  }
  console.error(
    '\nA line this long in source is not something anyone typed, and a task or file '
    + 'like this is not something anyone configured. Compare against the first clean '
    + 'commit before doing anything else, and do not run the app or install '
    + 'dependencies until it is clean.\n',
  );
  process.exit(1);
}

console.log(`Injected code check passed (nothing over ${MAX_LINE} characters, tasks.json clean).`);
