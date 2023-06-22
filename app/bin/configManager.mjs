'use strict';

// Configuration manager
// Downloads server configuration from a repo
// TODO: apply secrets from envvars?
// TODO: like workshop api key in some mod config

// Our libs
import { setupIpc, setPingReply, sendRequestReply } from '../lib/ipc.mjs';
import { lockFile, unlockFile } from '../lib/lockfile.mjs';
import { setupTerminationSignalHandlers } from '../lib/exitHandlers.mjs';
import { setupLog, isoTimestamp } from '../lib/log.mjs';
import { getDirName } from '../lib/dirname.mjs';
import { parseBool } from '../lib/parseBool.mjs';

// Nodejs stdlib
import { default as path } from 'node:path';
import { default as crypto } from 'node:crypto';

//
// Start boilerplate
// Debug modes
const debug = parseBool(process.env.DEBUG) || false;

// Module id
const moduleIdent = 'configManager';

// Populate __dirname
const __dirname = getDirName();

// Setup logger
const log = setupLog('bin/configManager.mjs');

// Flag start-of-log
log.info('honk.host gameserver manager v0.4.20');
log.info(`--- Logs begin at ${isoTimestamp()} ---`);

// Create our lockfile (throws if it fails)
await lockFile(moduleIdent);

// Setup our IPC "connection"
const ipc = await setupIpc(moduleIdent);

// Setup our termination handlers for SIGTERM and SIGINT
setupTerminationSignalHandlers(moduleIdent, ipc);

// Set initial ping reply
setPingReply(moduleIdent, ipc, 'init');

//
// End boilerplate

//
// Globals

// Keep track of in-progress downloads
const runningDownloads = {};

//
// Start logic

// Tell everyone we're alive
ipc.on('start', () => {
  setPingReply(moduleIdent, ipc, 'ready');
});

ipc.subscribe('configManager.downloadUpdateRepo', downloadUpdateRepo);

async function downloadUpdateRepo(request) {
  request = JSON.parse(request);
  log.info('Incoming downloadUpdateRepo request:', request);

  // Verify caller provided an appid and we support downloading it
  if (!request.repoUrl) {
    log.error('downloadUpdateRepo called without repoUrl, sending error');
    sendRequestReply(moduleIdent, ipc, 'error', new Error('repoUrl required'), request);
    return;
  }
  if (!request.gameConfigDir) {
    log.error('downloadUpdateRepo called without gameConfigDir, sending error');
    sendRequestReply(moduleIdent, ipc, 'error', new Error('gameConfigDir required'), request);
    return;
  }

  // Make sure config isn't mounted
  try {
    // Try to lock
    await lockFile(`configMount-${request.gameId}-${request.instanceId}`);
  } catch (error) {
    // If it errors, check to see if a download is running for our game
    if (error.code == 'EEXIST') {
      // If so, send the NACK along with the channel id they can sub to for progress messages
      log.warn('Could not lock, sending NACK with currently running transaction');
      sendRequestReply(
        moduleIdent,
        ipc,
        'nack',
        {
          alreadyRequested: true,
          reason: 'already requested',
          subscribeTo: runningDownloads[request.instanceId].request.replyTo,
          requestId: runningDownloads[request.instanceId].request.requestId,
          request: request,
        },
        request,
      );
      // And log a message
    } else {
      // Forward on other errors
      log.error('Could not lock, sending NACK with error', error);
      sendRequestReply(moduleIdent, ipc, 'error', error, request);
    }
    return;
  }
}
