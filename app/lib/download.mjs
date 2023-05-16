'use strict';

// Nodejs stdlib
import { default as fs } from 'node:fs';
import { default as path } from 'node:path';

// External libs
import { default as needle } from 'needle';
import { default as tar } from 'tar';

export function downloadFile(
  url = '',
  outputPath = '',
  options = {
    untar: false,
  },
) {
  return new Promise((resolve, reject) => {
    if (!url) {
      return reject('url required');
    }
    if (!outputPath) {
      return reject('output path required');
    }

    const normalizedCwdPath = path.normalize(outputPath);
    const normalizedFilePath = path.normalize(`${normalizedCwdPath}/steamcmd.tar`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const outputFile = fs.createWriteStream(normalizedFilePath);
    needle
      .get(url)
      .pipe(outputFile)
      .on('done', (err) => {
        if (err) return reject(err);
        if (options.untar) {
          // eslint-disable-next-line promise/no-promise-in-callback
          extractTarGz(normalizedFilePath, {
            cwd: normalizedCwdPath,
          })
            .then(() => {
              return resolve();
            })
            .catch((err) => {
              return reject(err);
            });
        } else {
          return resolve();
        }
      });
  });
}

export function extractTarGz(file = '', options = {}) {
  return new Promise((resolve, reject) => {
    // Build tar options
    // For now only strip and cwd are supported/needed
    const tarOptions = {};

    // file path to extract
    if (file === '') return reject(new Error('file path required'));
    tarOptions.file = file;

    // --strip=N
    // eslint-disable-next-line no-prototype-builtins
    if (options.hasOwnProperty('strip')) tarOptions.strip = options.strip;

    // -C /some/path
    // eslint-disable-next-line no-prototype-builtins
    if (options.hasOwnProperty('cwd')) tarOptions.cwd = options.cwd;

    // Read the file in and extract it
    tar
      .extract(tarOptions, (err) => {
        if (err) return reject(err);
        return resolve();
      })
      .then(() => {
        return resolve();
      })
      .catch((err) => {
        return reject(err);
      });
  });
}
