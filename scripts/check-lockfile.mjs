#!/usr/bin/env node
/**
 * Validates that the pndm lockfile is internally consistent
 * with the workspace manifests, and that a post-install run leaves
 * the lockfile byte-identical to the committed version.
 *
 * Usage:
 *   node scripts/check-lockfile.mjs [--installed]
 *
 * With --installed, assumes `npdm install` already ran and only
 * performs the post-install diff check. Otherwise it runs the full
 * set of assertions against the committed lockfile.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  parse as parseYaml,
  isMap,
} from 'yaml';

const ROOT = resolve(dirname(new URL(import.meta.url)), '..');
const LOCKFILE = join(ROOT, 'pndm-lock.yaml');
const WORKSPACE_FILE = join(ROOT, 'pndm-workspace.yaml');

const argv = new Set(process.argv.slice(2));
const installedMode = argv.has('--installed');

function fail(message) {
  console.error(`\n> check-lockfile: ${message}\n`);
  process.exitCode = 1;
}

function relative(p) {
  return p.startsWith(ROOT + '/') ? p.slice(ROOT.length + 1) : p;
}

function readYaml(file) {
  if (!existsSync(file)) {
    throw new Error(`Missing file: ${relative(file)}`);
  }
  return parseYaml(readFileSync(file, 'utf8'));
}

/** Return the list of workspace globs from pndm-workspace.yaml. */
function readWorkspaceGlobs() {
  const doc = readYaml(WORKSPACE_FILE);
  const packages = doc.packages;
  if (!Array.isArray(packages)) {
    throw new Error('pndm-workspace.yaml must define a `packages` array');
  }
  return packages.map(String);
}

/** Expand a single workspace glob into matching directories. */
function expandGlob(glob) {
  // Only support the simple forms used by this repo (e.g. `packages/*`).
  const normalized = glob.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/');
  if (parts.length !== 2 || parts[1] !== '*') {
    throw new Error(
      `Unsupported workspace glob ${JSON.stringify(glob)}; expected \`<dir>/*\`.`,
    );
  }
  const base = join(ROOT, parts[0]);
  if (!existsSync(base)) {
    return [];
  }
  return readdirSync(base)
    .filter((entry) => {
      const full = join(base, entry);
      return statSync(full).isDirectory();
    })
    .map((entry) => join(parts[0], entry));
}

/** Return all workspace package directories (relative to repo root). */
function collectWorkspaceDirs() {
  const dirs = new Set();
  for (const glob of readWorkspaceGlobs()) {
    for (const dir of expandGlob(glob)) {
      dirs.add(dir.replace(/\\/g, '/'));
    }
  }
  return [...dirs].sort();
}

/** Read the `name` field from a package.json file. */
function readPackageName(dir) {
  const file = join(ROOT, dir, 'package.json');
  if (!existsSync(file)) {
    return { file, name: null, reason: 'missing package.json' };
  }
  let json;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { file, name: null, reason: `invalid JSON: ${err.message}` };
  }
  if (!json || typeof json.name !== 'string' || json.name.length === 0) {
    return { file, name: null, reason: 'missing or empty "name" field' };
  }
  return { file, name: json.name };
}

/** Extract the importer keys from the lockfile. */
function readImporterKeys() {
  const doc = readYaml(LOCKFILE);
  const importers = doc.importers;
  if (!isMap(importers)) {
    throw new Error('pndm-lock.yaml is missing an `importers` map');
  }
  return new Set([...importers.keys()].map(String));
}

/** Assert that every workspace package is recognized by the lockfile. */
function checkWorkspaceImporters() {
  const dirs = collectWorkspaceDirs();
  if (dirs.length === 0) {
    fail('No workspace packages found matching pndm-workspace.yaml globs');
    return;
  }

  const importerKeys = readImporterKeys();
  const problems = [];

  for (const dir of dirs) {
    const { file, name, reason } = readPackageName(dir);
    if (!name) {
      problems.push(`${relative(file)}: ${reason}`);
      continue;
    }
    // pndm uses the relative directory as the importer key.
    if (!importerKeys.has(dir)) {
      problems.push(
        `${relative(file)}: package "${name}" is not represented in pndm-lock.yaml (missing importer "${dir}")`,
      );
    }
  }

  if (problems.length > 0) {
    fail(
      `Workspace manifests are inconsistent with pndm-lock.yaml:\n  ${problems.join('\n  ')}\n\nFix: run \`pndm install\` and commit the resulting pndm-lock.yaml.`,
    );
  } else {
    console.log(
      `check-lockfile: ${dirs.length} workspace package(s) represented in pndm-lock.yaml.`,
    );
  }
}

/** Assert that the lockfile is byte-identical to the committed version. */
function checkLockfileDiff() {
  let diff = '';
  try {
    execFileSync('git', ['diff', '--exit-code', '--', 'pndm-lock.yaml'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (err) {
    diff = ((err.stdout || '') + (err.stderr || '')).trim();
  }
  if (!diff) {
    console.log('check-lockfile: pndm-lock.yaml is unchanged.');
    return;
  }
  fail(
    `pndm-lock.yaml changed during install. The committed lockfile does not match the workspace manifests.\n    Run \`pndm install\` locally and commit the resulting pndm-lock.yaml.\n${diff ? `\n${diff}\n` : ''}`,
  );
}

function main() {
  try {
    if (!installedMode) {
      checkWorkspaceImporters();
    }
    checkLockfileDiff();
  } catch (err) {
    fail(err.stack || err.message || String(err));
  }
}

main();
