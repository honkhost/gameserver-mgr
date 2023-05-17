'use strict';

// Our libs
import { timestamp } from './timestamp.mjs';

// Nodejs stdlib
import { default as fs } from 'node:fs';
import { default as path } from 'node:path';
import { default as crypto } from 'node:crypto';

const mgrTmpDir = process.env.MANAGER_TMPDIR || '/tmp/gameserver-mgr';

// Attempt to create a pid file
export function setPidFile(ident = '') {
  // Doesn't strictly need to return a promise, but it's more standarized with lockfile/ipc
  return new Promise((resolve, reject) => {
    // Ensure our dirs exist
    try {
      checkPidPath();
    } catch (err) {
      return reject(err);
    }

    // Normalize the path
    const pidPath = path.resolve(path.normalize(`${mgrTmpDir}/pid/${ident}.pid`));

    // Grab our pid
    const pid = process.pid.toString();

    // And write it to the file
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.writeFileSync(pidPath, pid, 'utf8');
      // Set a listener to remove our pid file on exit
      process.on('exit', () => {
        fs.rmSync(pidPath);
      });

      return resolve(pidPath);
    } catch (err) {
      console.log(`[${timestamp()}] Could not create pid file at ${pidPath}`);
      return reject(new Error(`Could not create pid file at ${pidPath}`));
    }
  });
}

// Ensure that /tmp/gameserver-mgr/ipc exists
function checkPidPath() {
  const pidPath = path.resolve(path.normalize(`${mgrTmpDir}/pid`));
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!fs.existsSync(`${pidPath}`)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.mkdirSync(`${pidPath}`, { recursive: true });
    }
  } catch (err) {
    if (err) {
      console.log(`[${timestamp()}] Could not create pid directory at ${pidPath}`, err);
      throw new Error(`Could not create pid directory at ${pidPath}`);
    }
  }
}
