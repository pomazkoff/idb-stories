#!/usr/bin/env node
/**
 * Генерирует тестовые изображения для E2E (закоммичены рядом, повторно запускать не нужно):
 *   slide.jpg — 720×1280 (минимум для слайда), cover.png — 256×256 (минимум для обложки).
 * sharp берётся из apps/worker (в админке его нет):  node apps/admin/e2e/fixtures/generate.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(new URL('../../../worker/package.json', import.meta.url));
const sharp = require('sharp');

function gradientSvg(width, height, from, to, label) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
      </linearGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 4}" fill="#ffffff" fill-opacity="0.35"/>
      <text x="50%" y="90%" font-family="sans-serif" font-size="${Math.round(width / 12)}" fill="#fff" text-anchor="middle">${label}</text>
    </svg>`,
  );
}

await sharp(gradientSvg(720, 1280, '#1c1b1a', '#b08d57', 'E2E'))
  .jpeg({ quality: 70, mozjpeg: true })
  .toFile(`${here}slide.jpg`);

await sharp(gradientSvg(256, 256, '#b08d57', '#1c1b1a', 'E2E'))
  .png({ compressionLevel: 9 })
  .toFile(`${here}cover.png`);

console.log('OK: slide.jpg (720×1280), cover.png (256×256)');
