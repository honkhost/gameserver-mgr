'use strict';

// Our libs
import { setupLog } from './log.mjs';
import { parseBool } from './parseBool.mjs';

// Nodejs stdlib
import { default as fs } from 'node:fs';
import { default as path } from 'node:path';

// External libs
import { default as qfsq } from 'qlobber-fsq';

const log = setupLog('lib/ipc.mjs');

const mgrTmpDir = process.env.MANAGER_TMPDIR || '/tmp/gameserver-mgr';
const ipcPath = path.resolve(`${mgrTmpDir}/ipc`);

const debugIpc = parseBool(process.env.DEBUG_IPC) || false;

/**
 * Setup the ipc object
 * @param {String} moduleIdent - the module's moduleIdent
 * @returns {Promise<qfsq.QlobberFSQ>} the IPC object for further use
 */
export function setupIpc(moduleIdent = '') {
  return new Promise((resolve, reject) => {
    // First make sure the directory exists
    try {
      checkIpcPath();
    } catch (err) {
      return reject(err);
    }

    // Create an ipc object
    const ipc = new qfsq.QlobberFSQ({ fsq_dir: ipcPath });

    // Then return it
    return resolve(ipc);
  });
}

/**
 * Check that /tmp/gameserver-mgr/ipc exists
 * @returns {void}
 */
function checkIpcPath() {
  try {
    // See if the directory exists
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!fs.existsSync(`${ipcPath}`)) {
      // If not, create it
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.mkdirSync(`${ipcPath}`, { recursive: true });
    }
  } catch (error) {
    if (error) {
      // If it broke
      throw new Error(`Could not create ipc directory at ${ipcPath}`);
    }
  }
}

/**
 * Setup ping replies
 * @param {String} moduleIdent - the module's moduleIdent
 * @param {qfsq.QlobberFSQ} ipc - the module's ipc object
 * @param {String} status - the status to report
 * @returns {void}
 */
export function setPingReply(moduleIdent = '', ipc = qfsq.QlobberFSQ, status = '') {
  if (debugIpc) {
    log.debug(`Setting ping reply for ${moduleIdent} to:`, status);
  }

  // Clear old subscriptions
  ipc.unsubscribe(`${moduleIdent}.ping`);
  ipc.unsubscribe(`_broadcast.ping`);

  // Subscribe to targeted ping requests
  ipc.subscribe(`${moduleIdent}.ping`, (data) => {
    const pingRequest = JSON.parse(data);

    // Build the reply
    const pingReply = {
      msgId: pingRequest.msgId,
      moduleIdent: moduleIdent,
      timestamp: Date.now(),
      msg: 'pong',
      pid: process.pid,
      status: status,
      uptime: process.uptime(),
      resourceUsage: process.resourceUsage(),
    };

    // Send it out
    ipc.publish(pingRequest.replyTo, JSON.stringify(pingReply));
  });

  // Subscribe to broadcast ping requests
  ipc.subscribe('_broadcast.ping', (data) => {
    const pingRequest = JSON.parse(data);

    // Build the reply
    const pingReply = {
      msgId: pingRequest.msgId,
      moduleIdent: moduleIdent,
      timestamp: Date.now(),
      msg: 'pong',
      pid: process.pid,
      status: status,
      uptime: process.uptime(),
      resourceUsage: process.resourceUsage(),
    };

    // Send it out
    ipc.publish('_broadcast.pong', JSON.stringify(pingReply));
  });
}

/**
 * Sends a reply to the initial request on a given channel
 * @param {String} moduleIdent - the callers moduleIdent
 * @param {Object} ipc - the ipc object
 * @param {String} subchannel - the subchannel to message
 * @param {String|Object} message - the message to send as reply.message
 * @param {Object<String>} info - requestId and replyTo to use
 * @param {String} info.requestId - requestId to reply to
 * @param {String} info.replyTo - main channel to message
 */
export async function sendRequestReply(moduleIdent, ipc, subchannel, message, info) {
  message.requestId = info.requestId;
  message.moduleIdent = moduleIdent;
  message.timestamp = Date.now();

  if (debugIpc) log.debug(`Outgoing sendRequestReply on ${info.replyTo}.${subchannel}:`, message);

  // Fire off the reply (hopefully they're listening)
  await ipc.publish(`${info.replyTo}.${subchannel}`, JSON.stringify(message));
}
