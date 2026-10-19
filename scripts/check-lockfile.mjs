#!/usr/bin/env node
/**
 * Validates that the pnpm lockfile is internally consistent with
 * the workspace manifests, and that an install did not mutate it.
 *
 * Usage:
 *   node scripts/check-lockfile.mjs
 *
 * Exits with a non-zero code and a message naming the offending file
 * when a problem is detected.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs'; import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockfilePath = join(root, 'pnpm-lockfile.yaml');
const workspacePath = join(root, 'pnpm-workspace.yaml');

const errors = [];

function fail(message) {
  errors.push(message);
}

// -----------------------------------------------------------------------------
// 1. Post-install diff check: the install must not have mutated the
//    committed lockfile.
// ----------------------------------------------------------------------------
// We only run this check if we are in a git repo and the lockfile is
// tracked. Otherwise there is nothing to compare against.
function checkLockfileUnchanged() {
  if (!existsSync(lockfilePath)) {
    fail(`pnpm-lockfile.yaml is missing at ${lockfilePath}`);
    return;
  }

  const insideGit = execSync('git', ['rev-parse', '--showtoplevel'], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (insideGit.status !== 0) {
    console.warn('[check-lockfile] Not in a git repo, skipping diff check.');
    return;
  }

  const tracked = execSync('git', ['ls-files', '--', 'pnpm-lockfile.yaml'], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (tracked.status !== 0 || tracked.stdout.trim() === '') {
    console.warn('[check-lockfile] pnpm-lockfile.yaml is not tracked, skipping diff check.');
    return;
  }

  const diff = execSync('git', ['diff', '--exit-code', '--', 'pnpm-lockfile.yaml'], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (diff.status !== 0) {
    fail(
      'pnpm-lockfile.yaml was modified by install. ' +
        'The installed tree does not match the committed lockfile. ' +
        'Run `pnpm install` locally and commit the resulting pnpm-lockfile.yaml.\n' +
        `git diff output:\n${diff.stdout}${diff.stderr}`,
    );
  }
}

// -----------------------------------------------------------------------------
// 2. Workspace glob consistency check.
//
//    Every directory matched by the workspace globs must contain a
//    package.json with a name, and that name must match the lockfile's
//    importer key for that directory.
// -----------------------------------------------------------------------------
// Minimal parser for the subset of YAML used by pnpm-workspace.yaml and
// pnpm-lockfile.yaml. We only need top-level keys and the importers
// block, so we avoid adding a yaml dependency.
function parseWorkspacePackages(content) {
  const lines = content.split(/\r?\n/);
  const packages = [];
  let inPackages = false;
  let packagesIndent = -1;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').replace(/\s+$/, '');
    if (line.trim() === '') continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (!inPackages) {
      if (/^packages\s*:/.test(trimmed)) {
        inPackages = true;
        packagesIndent = indent;
      }
      continue;
    }

    if (indent <= packagesIndent && !/^-/.test(trimmed)) {
      // Left the packages block.
      break;
    }

    const match = trimmed.match(/^-\s*(['"]?)([^'"]+)\1$/);
    if (match) {
      packages.push(match[2].trim());
    }
  }

  return packages;
}

function parseLockfileImporters(content) {
  const lines = content.split(/\r?\n/);
  const importers = new Map();
  let inImporters = false;
  let importersIndent = -1;
  let currentKey = null;
  let currentIndent = -1;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim() === '') continue;
    if (/^\s*#h/.test(line)) continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (!inImporters) {
      if (/^importers\s*:/.test(trimmed)) {
        inImporters = true;
        importersIndent = indent;
      }
      continue;
    }

    if (indent <= importersIndent) {
      // Left the importers block.
      break;
    }

    // Importer keys are indented one level deeper than the `importers`
    // key itself. They look like `packages/foo/:` or `.`:.
    const keyMatch = trimmed.match(/^(.+):\s*$/);
    if (keyMatch && indent === importersIndent + 2) {
      currentKey = keyMatch[1].trim().replace(/^(['"])(.+)\1$/, '$2');
      currentIndent = indent;
      importers.set(currentKey, { key: currentKey });
      continue;
    }

    if (currentKey !== null && indent <= currentIndent) {
      currentKey = null;
    }
  }

  return importers;
}

function expandGlob(glob) {
  // Support the simple `somedir/*` form used by the workspace.
  const star = glob.indexOf('*');
  if (star === -1) {
    const abs = resolve(root, glob);
    return existsSync(abs) ? [glob] : [];
  }

  const prefix = glob.slice(0, star).replace(/\/$/, '');
  const suffix = glob.slice(star + 1);
  const baseDir = resolve(root, prefix);
  if (!existsSync(baseDir)) return [];

  const entries = readdirSync(baseDir, { withFileTypes: true });
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (suffix && !entry.name.endsWith(suffix)) continue;
    matches.push(join(prefix, entry.name));
  }
  return matches;
}

function checkWorkspaceConsistency() {
  if (!existsSync(workspacePath)) {
    fail('pnpm-workspace.yaml is missing');
    return;
  }
  if (!existsSync(lockfilePath)) {
    // Already reported by the diff check.
    return;
  }

  const workspaceContent = readFileSync(workspacePath, 'utf8');
  const globs = parseWorkspacePackages(workspaceContent);
  if (globs.length === 0) {
    console.warn('[check-lockfile] No packages globs found in pnpm-workspace.yaml.');
    return;
  }

  const lockfileContent = readFileSync(lockfilePath, 'utf8');
  const importers = parseLockfileImporters(lockfileContent);

  const seen = new Set();
  for (const glob of globs) {
    const dirs = expandGlob(glob);
    for (const dir of dirs) {
      if (seen.has(dir)) continue;
      seen.add(dir);

      const manifestPath = join(root, dir, 'package.json');
      if (!existsSync(manifestPath)) {
        fail(`${dir}/package.json is missing but the directory matches workspace glob "${glob}".`);
        continue;
      }

      let manifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch (err) {
        fail(`${dir}/package.json is not valid JSON: ${err.message}`);
        continue;
      }

      if (!manifest.name || typeof manifest.name !== 'string') {
        fail(`${dir}/package.json is missing a "name" field.`);
        continue;
      }

      const importerKey = dir.replace(/\\/g, '/');
      if (!importers.has(importerKey)) {
        fail(
          `${dir}/package.json declares "${manifest.name}" but pnpm-lockfile.yaml has no importer entry for "${importerKey}". ` +
            'Run `pnpm install` and commit the updated pnpm-lockfile.yaml.',
        );
      }
    }
  }
}

function main() {
  checkLockfileUnchanged();
  checkWorkspaceConsistency();

  if (errors.length > 0) {
    console.error('\n[check-lockfile] Lockfile check failed:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log('[check-lockfile] pnpm-lockfile.yaml is consistent with the workspace manifests.');
}

main();
