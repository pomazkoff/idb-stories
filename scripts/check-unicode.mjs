#!/usr/bin/env node
/**
 * Защита от Trojan Source и скрытых символов (T10): в исходниках запрещены невидимые и bidi-символы
 * (категория Unicode Cf и неразрывный пробел). В строках их нужно писать escape-последовательностями.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) =>
    /\.(ts|tsx|js|mjs|cjs|json|ya?ml|css|html|md|prisma|sql|sh|conf|template)$/.test(f),
  );
const NBSP = 0xa0;
const isHidden = (ch) => /\p{Cf}/u.test(ch) || ch.codePointAt(0) === NBSP;
let failed = false;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    const ch = [...line].find(isHidden);
    if (ch) {
      failed = true;
      console.error(
        `${file}:${i + 1}: скрытый символ U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
      );
    }
  });
}
if (failed) process.exit(1);
console.log(`Проверено файлов: ${files.length}, скрытых символов нет`);
