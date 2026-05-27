#!/usr/bin/env node

/**
 * Auto-generate learn-docs/README.md index
 *
 * Scans the repository for:
 * - learn-docs/collections/*.md
 * - **\/src/docs/*.learn.md and **\/src/docs/*.md (excluding node_modules)
 *
 * Then regenerates the learn-docs/README.md with an up-to-date document index.
 *
 * Usage:
 *   node learn-docs/scripts/generate-index.mjs
 */

import { readdirSync, statSync, writeFileSync } from 'fs';
import { join, relative, basename, dirname } from 'path';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const LEARN_DOCS = join(ROOT, 'learn-docs');
const OUTPUT = join(LEARN_DOCS, 'README.md');

/**
 * Recursively find files matching a pattern
 */
function findFiles(dir, pattern, results = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;

    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      findFiles(fullPath, pattern, results);
    } else if (pattern.test(entry)) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Extract a title from filename (remove extension, replace separators)
 */
function titleFromFilename(filename) {
  return filename
    .replace(/\.learn\.md$/, '')
    .replace(/\.md$/, '')
    .replace(/^\d+-/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// --- Scan collections ---
const collectionsDir = join(LEARN_DOCS, 'collections');
const collections = findFiles(collectionsDir, /\.md$/)
  .sort()
  .map(f => {
    const name = basename(f);
    const relPath = `./collections/${name}`;
    const title = titleFromFilename(name);
    const numMatch = name.match(/^(\d+)/);
    const num = numMatch ? numMatch[1] : '';
    return { num, title, relPath };
  });

// --- Scan src/docs directories (source-adjacent docs) ---
const srcDocsPattern = /\.md$/;
const srcDocsDirs = [];

/**
 * Only scan "src/docs" directories inside packages/ — these are custom
 * learning documents added alongside source code. We skip top-level docs/
 * directories which are official Angular documentation.
 */
function findSrcDocsDirs(dir, depth = 0) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'learn-docs') continue;
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      // Only match "src/docs" pattern (custom learning docs next to source)
      if (fullPath.endsWith('/src/docs')) {
        const docsFiles = findFiles(fullPath, srcDocsPattern);
        if (docsFiles.length > 0) {
          srcDocsDirs.push({ dir: fullPath, files: docsFiles });
        }
      } else {
        findSrcDocsDirs(fullPath, depth + 1);
      }
    }
  }
}

// Only scan inside packages/ for source-adjacent learning docs
findSrcDocsDirs(join(ROOT, 'packages'));

// --- Group source-adjacent docs by package ---
const srcDocsGroups = srcDocsDirs.map(({ dir, files }) => {
  const relDir = relative(ROOT, dir);
  // Derive a readable module name from the path
  // e.g., packages/core/primitives/signals/src/docs → core/primitives/signals
  const moduleName = relDir
    .replace(/^packages\//, '')
    .replace(/\/src\/docs$/, '')
    .replace(/\/docs$/, '');

  const docs = files.sort().map(f => {
    const name = basename(f);
    const relPath = relative(LEARN_DOCS, f).replace(/\\/g, '/');
    // Use ../ prefix for paths outside learn-docs
    const linkPath = relPath.startsWith('..') ? relPath : `../${relPath}`;
    const title = titleFromFilename(name);
    return { title, linkPath, name };
  });

  return { moduleName, relDir, docs };
}).filter(g => g.docs.length > 0);

// --- Generate README content ---
let content = `# Angular Source Code Learning

> Learn more about Angular to benefit my career, solve issues with a clear mind, and practice learning skills when meeting new things.

## 📖 Document Index

### General Collections (\`learn-docs/collections/\`)

| # | Document | Title |
|---|----------|-------|
`;

for (const { num, title, relPath } of collections) {
  content += `| ${num} | [${basename(relPath)}](${relPath}) | ${title} |\n`;
}

for (const { moduleName, relDir, docs } of srcDocsGroups) {
  content += `\n### ${moduleName} (\`${relDir}/\`)\n\n`;
  content += `| Document | Title |\n`;
  content += `|----------|-------|\n`;
  for (const { title, linkPath, name } of docs) {
    content += `| [${name}](${linkPath}) | ${title} |\n`;
  }
}

content += `
## 📝 Conventions

- **Source-adjacent docs**: Notes tightly coupled to specific source code go in \`src/docs/\` next to the code (e.g., \`packages/core/primitives/signals/src/docs/\`)
- **General learning notes**: Cross-cutting or general notes go in \`learn-docs/collections/\`
- **Naming**: Use \`.learn.md\` suffix for learning documents, or place them in a \`docs/\` folder
- **Format**: Each document starts with metadata (date, topic, related source paths), followed by Q&A or "Question → Analysis → Conclusion" structure
- **Conflict safety**: Only add new files — never modify official Angular files. This ensures zero conflicts when syncing upstream.

## 🔄 Auto-generate this index

\`\`\`bash
node learn-docs/scripts/generate-index.mjs
\`\`\`

This script scans for all learning documents in \`learn-docs/collections/\` and \`**/src/docs/\` directories, then regenerates this README.
`;

writeFileSync(OUTPUT, content);
console.log(`✅ Generated ${relative(ROOT, OUTPUT)}`);
console.log(`   - ${collections.length} collection docs`);
console.log(`   - ${srcDocsGroups.length} source-adjacent doc groups`);
