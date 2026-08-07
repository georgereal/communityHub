#!/usr/bin/env node
/**
 * pre-push.js — Git pre-push hook (Node.js implementation)
 *
 * Runs before a push is sent to the remote. Checks if the repository map
 * needs regeneration (structural changes detected).
 *
 * Behavior:
 *   - Auto-regenerates stale REPO_MAP.md and warns (does NOT block the push)
 *   - Use --no-verify to bypass entirely
 *
 * Installed by: npm run setup:hooks
 * Manual install: cp scripts/git-hooks/pre-push .git/hooks/pre-push && chmod +x .git/hooks/pre-push
 *
 * Git feeds stdin lines: <local_ref> <local_sha> <remote_ref> <remote_sha>
 * We compare that commit range — NOT `git diff HEAD` (working tree), which is
 * empty after a clean commit and incorrectly skipped checks.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');

const ZERO_SHA = '0000000000000000000000000000000000000000';

function execGit(args) {
  return execSync(`git ${args}`, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Read push ref updates from stdin (git pre-push protocol).
 * @returns {Promise<Array<{ localRef, localSha, remoteRef, remoteSha }>>}
 */
async function readPushUpdates() {
  const updates = [];
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 4) {
      updates.push({
        localRef: parts[0],
        localSha: parts[1],
        remoteRef: parts[2],
        remoteSha: parts[3],
      });
    }
  }
  return updates;
}

/** Files changed in the commits being pushed (vs remote tip). */
function getChangedFilesFromUpdates(updates) {
  const files = new Set();

  for (const { localSha, remoteSha } of updates) {
    if (!localSha || localSha === ZERO_SHA) continue; // delete remote ref

    let range;
    if (!remoteSha || remoteSha === ZERO_SHA) {
      // New branch — compare against merge-base with main/master if possible
      let base = null;
      for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
        try {
          base = execGit(`merge-base ${candidate} ${localSha}`);
          if (base) break;
        } catch {
          /* try next */
        }
      }
      range = base ? `${base}...${localSha}` : localSha;
    } else {
      range = `${remoteSha}...${localSha}`;
    }

    try {
      const output = execGit(`diff --name-only ${range}`);
      output.split('\n').filter(Boolean).forEach((f) => files.add(f));
    } catch {
      try {
        const output = execGit(`diff-tree --no-commit-id --name-only -r ${localSha}`);
        output.split('\n').filter(Boolean).forEach((f) => files.add(f));
      } catch {
        /* ignore */
      }
    }
  }

  return [...files];
}

/** Fallback when stdin is empty (manual hook run). */
function getChangedFilesFallback() {
  try {
    const upstream = execGit('rev-parse --abbrev-ref @{upstream}');
    const output = execGit(`diff --name-only ${upstream}...HEAD`);
    return output.split('\n').filter(Boolean);
  } catch {
    try {
      const output = execGit('diff --name-only origin/main...HEAD');
      return output.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}

function matchesPatterns(files, patterns) {
  return files.some((file) => patterns.some((p) => file.includes(p)));
}

function runScript(scriptPath, timeoutMs = 120_000) {
  try {
    execSync(`node ${scriptPath}`, {
      cwd: ROOT,
      stdio: 'pipe',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    return true;
  } catch (err) {
    if (err.killed || err.signal === 'SIGKILL') {
      console.log(`⚠️  WARNING: ${scriptPath} timed out after ${timeoutMs / 1000}s — skipping`);
    }
    return false;
  }
}

function filesDiffer(file1, file2) {
  try {
    execSync(`diff -q "${file1}" "${file2}"`, { stdio: 'pipe' });
    return false;
  } catch {
    return true;
  }
}

async function main() {
  const updates = await readPushUpdates();
  let changedFiles =
    updates.length > 0 ? getChangedFilesFromUpdates(updates) : getChangedFilesFallback();

  // Also include uncommitted structural edits (rare, but useful)
  try {
    const dirty = execGit('diff --name-only HEAD');
    dirty.split('\n').filter(Boolean).forEach((f) => {
      if (!changedFiles.includes(f)) changedFiles.push(f);
    });
  } catch {
    /* ignore */
  }

  if (changedFiles.length === 0) {
    console.log('📋 No commits/files in push range — skipping pre-push checks');
    process.exit(0);
  }

  console.log(`📋 Running pre-push checks (${changedFiles.length} file(s) in push range)...\n`);

  let hasWarnings = false;

  const repoMapTriggers = [
    'src/',
    'api/',
    'scripts/',
    'package.json',
    'vite.config.js',
    'vercel.json',
  ];

  if (matchesPatterns(changedFiles, repoMapTriggers)) {
    console.log('🔍 Structural changes detected — checking repo map...');

    const repoMapPath = path.join(ROOT, 'docs', 'REPO_MAP.md');
    const tempPath = '/tmp/repo-map-before-push.md';

    if (fs.existsSync(repoMapPath)) {
      fs.copyFileSync(repoMapPath, tempPath);
    } else {
      fs.writeFileSync(tempPath, 'REPO_MAP_NOT_FOUND');
    }

    runScript('scripts/utilities/generate-repo-map.js');

    if (filesDiffer(tempPath, repoMapPath)) {
      console.log('⚠️  WARNING: Repository map is out of date!');
      console.log('   The repo map has been auto-regenerated. Please review and commit:');
      console.log('   git add docs/REPO_MAP.md && git commit --amend --no-edit');
      console.log('');
      console.log('   To skip this check: git push --no-verify');
      console.log('');
      hasWarnings = true;
    } else {
      console.log('✅ Repo map is up to date');
    }

    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
  } else {
    console.log('✅ No structural changes — skipping repo map check');
  }

  console.log('');
  if (hasWarnings) {
    console.log('⚠️  Pre-push checks finished with warnings (push was not blocked)');
  } else {
    console.log('✅ Pre-push checks complete');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('pre-push hook error:', err.message);
  process.exit(0); // never block push on hook bugs
});
