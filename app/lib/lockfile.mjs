'use strict';

// Our libs
import { timestamp } from './timestamp.mjs';

// Nodejs stdlib
import { default as fs } from 'node:fs';
import { default as path } from 'node:path';
import { default as crypto } from 'node:crypto';

// External libs
import { default as lock } from 'lockfile';

const mgrTmpDir = process.env.MANAGER_TMPDIR || '/tmp/gameserver-mgr';

// Attempt to create a lockfile
export function lockFile(ident = '') {
  return new Promise((resolve, reject) => {
    // Ensure our dirs exist
    checkLockPath();

    // Normalize the path
    const lockPath = path.resolve(path.normalize(`${mgrTmpDir}/lock/${ident}.lock`));

    // Attempt to lock
    lock.lock(lockPath, (err) => {
      if (err) {
        console.log(`[${timestamp()}] Unable to acquire lock at ${lockPath} (Process already running?)`, err);
        return reject(new Error(`Unable to acquire lock at ${lockPath} (Process already running?)`, err));
      } else {
        return resolve(lockPath);
      }
    });
  });
}

// Attempt to remove a lockfile
export function unlockFile(ident = '') {
  return new Promise((resolve, reject) => {
    // Ensure our dirs exist
    try {
      checkLockPath();
    } catch (err) {
      return reject(err);
    }

    // Normalize the path
    const lockPath = path.resolve(path.normalize(`${mgrTmpDir}/lock/${ident}.lock`));

    // Attempt to unlock
    lock.unlock(lockPath, (err) => {
      if (err) {
        console.log(`[${timestamp()}] Unable to unlock ${lockPath}`, err);
        return reject(new Error(`Unable to unlock ${lockPath}`, err));
      } else {
        return resolve(lockPath);
      }
    });
  });
}

// Ensure that /tmp/gameserver-mgr/ipc exists
function checkLockPath() {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!fs.existsSync(`${mgrTmpDir}/lock`)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.mkdirSync(`${mgrTmpDir}/lock`, { recursive: true });
    }
  } catch (err) {
    if (err) {
      console.log(`[${timestamp()}] Could not create lockfile directory at ${mgrTmpDir}`, err);
      throw new Error(`Could not create lockfile directory at ${mgrTmpDir}`);
    }
  }
}
