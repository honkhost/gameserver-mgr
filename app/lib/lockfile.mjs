'use strict';

// Our libs
import { setupLog } from './log.mjs';

// Nodejs stdlib
import { default as fs } from 'node:fs';
import { default as path } from 'node:path';

// External libs
import { default as lock } from 'lockfile';

const log = setupLog('lib/lockfile.mjs');

const mgrTmpDir = process.env.MANAGER_TMPDIR || '/tmp/gameserver-mgr';

/**
 * Attempt to create a lockfile
 * @param {String} lock - the lockfile to create
 * @returns {Promise<string>} resolves when locked, rejects on error
 */
export function lockFile(lockId = '') {
  log.debug(`Attempting to acquire lock for ${lockId}`);
  return new Promise((resolve, reject) => {
    // Ensure our dirs exist
    checkLockPath();

    // Normalize the path
    const lockPath = path.resolve(path.normalize(`${mgrTmpDir}/lock/${lockId}.lock`));

    // Attempt to lock
    lock.lock(lockPath, (error) => {
      if (error) {
        log.debug(error);
        return reject(new Error(`Unable to acquire lock at ${lockPath}`, error));
      } else {
        return resolve(lockPath);
      }
    });
  });
}

/**
 * Attempt to remove a lockfile
 * @param {String} moduleIdent the module's moduleIdent
 * @returns {Promise<string>} resolves when unlocked, rejects on error
 */
export function unlockFile(moduleIdent = '') {
  return new Promise((resolve, reject) => {
    // Ensure our dirs exist
    try {
      checkLockPath();
    } catch (error) {
      return reject(error);
    }

    // Normalize the path
    const lockPath = path.resolve(path.normalize(`${mgrTmpDir}/lock/${moduleIdent}.lock`));

    // Attempt to unlock
    lock.unlock(lockPath, (error) => {
      if (error) {
        return reject(error);
      } else {
        return resolve(lockPath);
      }
    });
  });
}

/**
 * Ensure that /tmp/gameserver-mgr/lock exists
 * @returns {void}
 */
function checkLockPath() {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!fs.existsSync(`${mgrTmpDir}/lock`)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.mkdirSync(`${mgrTmpDir}/lock`, { recursive: true });
    }
  } catch (error) {
    if (error) {
      throw new Error(`Could not create lockfile directory at ${mgrTmpDir}`);
    }
  }
}
