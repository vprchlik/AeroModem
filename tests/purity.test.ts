import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * DSP purity: nothing under these directories may reference Web Audio / DOM
 * globals or import from src/audio or src/ui. The identical code must run in
 * Node (tests, bench CLI) and the browser.
 */
const PURE_DIRS = ['src/dsp', 'src/channel', 'src/util'];

const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: 'AudioContext', re: /\bAudioContext\b/ },
  { name: 'AudioWorklet', re: /\bAudioWorklet\w*\b/ },
  { name: 'window.* property access', re: /\bwindow\.\w+/ },
  { name: 'document.* property access', re: /\bdocument\.\w+/ },
  { name: 'navigator.*', re: /\bnavigator\.\w+/ },
  { name: 'import from src/audio', re: /from\s+['"][^'"]*\/audio\// },
  { name: 'import from src/ui', re: /from\s+['"][^'"]*\/ui\// },
  { name: 'Math.random', re: /\bMath\.random\b/ },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('DSP purity', () => {
  for (const dir of PURE_DIRS) {
    it(`${dir} contains no audio/DOM references or Math.random`, () => {
      const files = walk(dir);
      expect(files.length).toBeGreaterThan(0);
      const violations: string[] = [];
      for (const f of files) {
        const text = readFileSync(f, 'utf8');
        for (const { name, re } of FORBIDDEN) {
          if (re.test(text)) violations.push(`${f}: ${name}`);
        }
      }
      expect(violations).toEqual([]);
    });
  }
});
