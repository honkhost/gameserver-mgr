'use strict';

// Our libs
import { getDirName } from './dirname.mjs';

// Nodejs stdlib
import { default as path } from 'node:path';

const __dirname = getDirName();

/**
 * Load gameInfo manifest
 * @param {String} gameId - the gameId to load
 * @returns {Object} the gameInfo manifest
 */
export async function loadManifest(gameId) {
  // Game info manifest (download type, etc)
  // eslint-disable-next-line node/no-unsupported-features/es-syntax
  const _manifest = await import(path.normalize(path.resolve(`${__dirname}/../manifests/${gameId}.mjs`)));
  const manifest = _manifest.manifest;
  return manifest;
}
