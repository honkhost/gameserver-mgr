'use strict';

import { fileURLToPath } from 'node:url';
import { default as path } from 'node:path';

/**
 * Because we're using modules, we need to populate __dirname ourselves
 * @returns {String} __dirname
 */
export function getDirName() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return __dirname;
}

/**
 * Because we're using modules, we need to populate __filename ourselves
 * @returns {String} __filename
 */
export function getFileName() {
  const __filename = fileURLToPath(import.meta.url);
  return __filename;
}
