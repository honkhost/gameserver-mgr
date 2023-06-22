'use strict';

// Nodejs stdlib
import { default as fs } from 'node:fs';
import { default as path } from 'node:path';

// External libs
import { default as lock } from 'lockfile';

const mgrTmpDir = process.env.MANAGER_TMPDIR || '/tmp/gsm';

export const lockDir = await path.resolve(`${mgrTmpDir}/lock`);

/**
 * Attempt to create a lockfile
 * @param {String} lock - the lockfile to create
 * @returns {Promise<string>} resolves when locked, rejects on error
 */
export function lockFile(lockId = '') {
  return new Promise((resolve, reject) => {
    // Ensure our dirs exist
    checkLockPath();

    // Normalize the path
    const lockPath = path.resolve(`${lockDir}/${lockId}`);

    // Attempt to lock
    lock.lock(lockPath, (error) => {
      if (error) {
        return reject(error);
      } else {
        return resolve(true);
      }
    });
  });
}

/**
 * Attempt to remove a lockfile
 * @param {String} moduleIdent the module's moduleIdent
 * @returns {Promise<String>} resolves when unlocked, rejects on error
 */
export function unlockFile(lockId = '') {
  return new Promise((resolve, reject) => {
    // Ensure our dirs exist
    try {
      checkLockPath();
    } catch (error) {
      return reject(error);
    }

    // Normalize the path
    const lockPath = path.resolve(`${lockDir}/${lockId}`);

    // Attempt to unlock
    lock.unlock(lockPath, (error) => {
      if (error) {
        return reject(new Error(`Unable to release lock at ${lockPath}`, error));
      } else {
        return resolve(lockPath);
      }
    });
  });
}

/**
 * Check if a lock is present
 * @param {String} pattern regex to match on
 * @returns {Promise<Boolean>}
 */
export function isLocked(pattern = '', stale = false) {
  return new Promise((resolve, reject) => {
    // Make sure the lock path exists
    try {
      checkLockPath();
    } catch (error) {
      return reject(error);
    }

    const lockCheckOpts = {};
    stale ? (lockCheckOpts.stale = stale) : (lockCheckOpts.stale = false);

    // Build the regex
    // eslint-disable-next-line security/detect-non-literal-regexp
    const regex = new RegExp(pattern);

    // fetch list of locks
    const locks = listLocks();
    for (let i = 0; i <= locks.length; i++) {
      // eslint-disable-next-line security/detect-object-injection
      if (regex.test(locks[i])) {
        // eslint-disable-next-line security/detect-object-injection
        const lockPath = path.resolve(`${lockDir}/${locks[i]}`);
        const lockStatus = lock.checkSync(lockPath, lockCheckOpts);
        return resolve(lockStatus);
      } else if (i === locks.length) {
        return resolve(false);
      }
    }
  });
}

/**
 * Ensure that /tmp/gameserver-mgr/lock exists
 * @returns {void}
 */
export function checkLockPath() {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!fs.existsSync(`${mgrTmpDir}/lock`)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.mkdirSync(`${mgrTmpDir}/lock`, { recursive: true });
    }
    return;
  } catch (error) {
    if (error) {
      throw new Error(`Could not create lockfile directory at ${mgrTmpDir}`);
    }
  }
}

export function listLocks() {
  try {
    checkLockPath();
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const files = fs.readdirSync(path.resolve(`${lockDir}`));
    return files;
  } catch (error) {
    throw new Error(error);
  }
}
