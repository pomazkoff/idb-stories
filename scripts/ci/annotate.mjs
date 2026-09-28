#!/usr/bin/env node
/**
 * Публикует находки сканеров CI в аннотацию и сводку прогона GitHub Actions.
 * Логи Actions видны только после входа, а аннотации и сводка — всем, у кого есть доступ к репозиторию,
 * в том числе через публичный API (check-runs/{id}/annotations).
 *   <команда> | node scripts/ci/annotate.mjs "заголовок"
 * ANNOTATE_LEVEL=warning — уровень warning (GitHub показывает не больше 10 error- и 10 warning-аннотаций на шаг).
 */
import { appendFileSync } from 'node:fs';

const MAX_LINES = 60;
const title = process.argv[2] ?? 'CI';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const lines = Buffer.concat(chunks)
  .toString('utf8')
  .split('\n')
  .map((l) => l.trimEnd())
  .filter(Boolean);
if (lines.length === 0) process.exit(0);

const shown = lines.slice(0, MAX_LINES);
if (lines.length > MAX_LINES) shown.push(`… и ещё ${lines.length - MAX_LINES}`);

// Экранирование команд рабочего процесса: https://docs.github.com/actions/reference/workflow-commands
const escData = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const level = process.env.ANNOTATE_LEVEL === 'warning' ? 'warning' : 'error';
console.log(`::${level} title=${escProp(title)}::${escData(shown.join('\n'))}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### ${title}\n\n\`\`\`\n${shown.join('\n')}\n\`\`\`\n\n`,
  );
}
