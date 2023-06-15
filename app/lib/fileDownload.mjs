'use strict';

// Our libs
import { setupLog } from './log.mjs';

// Nodejs stdlib
import { default as fs } from 'node:fs';
import { default as path } from 'node:path';

// External libs
import { default as needle } from 'needle';
import { default as tar } from 'tar';

const log = setupLog('lib/fileDownload.mjs');

/**
 * Download a file from a url
 * @param {String} url - the url of the file to download
 * @param {String} outputPath - the path to save the file to
 * @param {Object.<Boolean>} options - the options for the download
 * @param {Boolean} options.untar - untar the file if set to true
 * @returns {Promise} resolves when file download is completed, rejects on error
 */
export function downloadFile(
  url = '',
  outputPath = '',
  options = {
    untar: false,
  },
) {
  log.debug(`Attempting download of ${url.split('/')[url.split('/').length - 1]} to ${outputPath}`);
  return new Promise((resolve, reject) => {
    if (!url) {
      return reject('url required');
    }
    if (!outputPath) {
      return reject('output path required');
    }

    const normalizedCwdPath = path.normalize(path.resolve(outputPath));
    const normalizedFilePath = path.normalize(path.resolve(`${normalizedCwdPath}/steamcmd.tar`));
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const outputFile = fs.createWriteStream(normalizedFilePath);
    needle
      .get(url)
      .pipe(outputFile)
      .on('done', async (error) => {
        if (error) return reject(error);
        log.debug(`Completed download of ${url.split('/')[url.split('/').length - 1]} to ${outputPath}`);
        if (options.untar) {
          // Schedule the untar for next tick so it has a better chance at succeeding
          process.nextTick(() => {
            // eslint-disable-next-line promise/no-promise-in-callback
            extractTarGz(normalizedFilePath, {
              cwd: normalizedCwdPath,
            })
              .then(() => {
                return resolve();
              })
              .catch((error) => {
                return reject(error);
              });
          });
        } else {
          return resolve();
        }
      });
  });
}

/**
 * Extract a tar.gz file
 * @param {String} file - the path to the tar.gz file
 * @param {Object.<Number, String>} options - tar options
 * @param {Number} options.strip - tar --strip=N
 * @param {String} options.cwd - tar -C /some/path
 * @returns {Promise} resolves when file download is completed, rejects on error
 */
export function extractTarGz(file = '', options = {}) {
  log.debug(`Attempting untar of ${file} with ${JSON.stringify(options)}`);
  return new Promise((resolve, reject) => {
    // Build tar options
    // For now only strip and cwd are supported/needed
    const tarOptions = {};

    // file path to extract
    if (file === '') return reject(new Error('file path required'));
    tarOptions.file = path.normalize(path.resolve(file));

    // --strip=N
    // eslint-disable-next-line no-prototype-builtins
    if (options.hasOwnProperty('strip')) tarOptions.strip = options.strip;

    // -C /some/path
    // eslint-disable-next-line no-prototype-builtins
    if (options.hasOwnProperty('cwd')) tarOptions.cwd = path.normalize(path.resolve(options.cwd));

    // Read the file in and extract it
    tar
      .extract(tarOptions)
      .then(() => {
        log.debug(`Completed untar of ${file} with ${JSON.stringify(options)}`);
        return resolve();
      })
      .catch((error) => {
        log.error(`Error untaring ${file}: ${error}`);
        return reject(error);
      });
  });
}
