'use strict';

// Nodejs stdlib
import { default as fs } from 'node:fs';
import { default as path } from 'node:path';

// External libs
import { default as lock } from 'lockfile';

// Our libs
import { parseBool } from './parseBool.mjs';
import { setupLog, isoTimestamp } from './log.mjs';

const mgrTmpDir = process.env.MANAGER_TMPDIR || '/tmp/gsm';

const lockDebug = parseBool(process.env.DEBUG_LOCK) || false;

// Setup logger
const log = setupLog('lib/lockfile.mjs');

export const lockDir = await path.resolve(`${mgrTmpDir}/lock`);

/**
 * Attempt to create a lockfile
 * @param {String} lock - the lockfile to create
 * @returns {Promise<string>} resolves when locked, rejects on error
 */
export function acquireLock(lockId = '') {
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
export function releaseLock(lockId = '') {
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
 * Block until a lock clears
 * @param {String} pattern regex of lock to wait for
 * @param {Number} timeout number of seconds to wait for a lock to clear
 * @returns {Boolean,Error} true if locks are cleared, Error if not.
 */
export async function spinClear(pattern, timeout = -1, checkInterval = 1) {
  while (await isLocked(pattern)) {
    timeout--;
    if (lockDebug) log.debug(`Waiting for locks to clear with pattern:`, pattern);
    if (timeout === 0) {
      throw new Error('Timeout exceeded');
    }
    await new Promise((resolve, reject) => {
      return setTimeout(resolve, checkInterval * 1000);
    });
  }
  return true;
}

/**
 * Block until we can lock, return the lock
 * @param {String} lockId lockid to attempt to lock
 * @param {Number} timeout number of seconds to wait for an existing lock to clear
 * @returns {Boolean,Error} true if lock is grabbed, Error if not
 * @throws {Error} if unable to lock within timeout
 */
export async function spinLock(lockId, timeout = -1, checkInterval = 1) {
  await spinClear(lockId, timeout, checkInterval);
  await acquireLock(lockId);
  return true;
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
