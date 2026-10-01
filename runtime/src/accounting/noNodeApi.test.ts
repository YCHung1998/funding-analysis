import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Task 1.1 / design.md Decision 1: runtime/src/accounting/ files MUST NOT import Node API
// (fs, path, process, ...), perform any I/O, or read the system clock — they are pure
// functions that both Vite (frontend) and tsx (server.ts) can import directly.
const ACCOUNTING_DIR = resolve(__dirname, '.');

const FORBIDDEN_IMPORT_PATTERN = /from\s+['"](node:|fs|path|process|child_process|http|https|net)(\/|['"])/;
const FORBIDDEN_CALL_PATTERN = /\b(Date\.now|setTimeout|setInterval|require\s*\()\s*\(/;

function sourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('runtime/src/accounting purity guard', () => {
  it('不得 import Node API 或讀系統時鐘（design.md Decision 1）', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(ACCOUNTING_DIR)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      if (FORBIDDEN_IMPORT_PATTERN.test(code) || FORBIDDEN_CALL_PATTERN.test(code)) {
        violations.push(relative(ACCOUNTING_DIR, file));
      }
    }
    expect(violations).toEqual([]);
  });
});
