'use strict';

// Our libs
import { timestamp } from './timestamp.mjs';

// Nodejs stdlib
import { default as fs } from 'node:fs';
import { default as path } from 'node:path';

// External libs
import { default as qfsq } from 'qlobber-fsq';

const mgrTmpDir = process.env.MANAGER_TMPDIR || '/tmp/gameserver-mgr';

// Returns the ipc object
export function setupIpc() {
  return new Promise((resolve, reject) => {
    // First make sure the directory exists
    try {
      checkIpcPath();
    } catch (err) {
      return reject(err);
    }

    // Create an ipc object
    const ipc = new qfsq.QlobberFSQ({ fsq_dir: `${mgrTmpDir}` });

    // Then return
    return resolve(ipc);
  });
}

// Ensure that /tmp/gameserver-mgr/ipc exists
function checkIpcPath() {
  const ipcPath = path.resolve(path.normalize(`${mgrTmpDir}/ipc`));
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!fs.existsSync(`${ipcPath}`)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.mkdirSync(`${ipcPath}`, { recursive: true });
    }
  } catch (err) {
    if (err) {
      console.log(`[${timestamp()}] Could not create ipc directory at ${ipcPath}`, err);
      throw new Error(`Could not create ipc directory at ${ipcPath}`);
    }
  }
}
