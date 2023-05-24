'use strict';

// Our libs
import { setupIpc, setPingReply } from '../lib/ipc.mjs';
import { lockFile, unlockFile } from '../lib/lockfile.mjs';
import { setupTerminationSignalHandlers } from '../lib/exitHandlers.mjs';
import { setupLog, isoTimestamp } from '../lib/log.mjs';
import { steamCmdDownloadSelf, steamCmdDownloadAppid } from '../lib/steamcmd.mjs';
import { getDirName } from '../lib/dirname.mjs';

// Nodejs stdlib
import { default as Stream } from 'node:stream';
import { default as path } from 'node:path';

const moduleIdent = 'downloadManager';

//
// Start boilerplate

const __dirname = getDirName();

// Setup logger
const log = setupLog('bin/downloadManager.mjs');

log.info('honk.host gameserver manager v0.4.20');
log.info(`--- Logs begin at ${isoTimestamp()} ---`);

// Create our lockfile
await lockFile(moduleIdent);

// Setup our IPC "connection"
const ipc = await setupIpc(moduleIdent);

// Setup our termination handlers for SIGTERM and SIGINT
setupTerminationSignalHandlers(moduleIdent, ipc);

// Set initial ping reply
setPingReply(moduleIdent, ipc, 'init');

//
// End boilerplate

const runningDownloads = {};

//
// Event listeners

ipc.on('start', () => {
  setPingReply(moduleIdent, ipc, 'running');
});

// Subscribe to downloadUpdateGame requests
ipc.subscribe(`downloadManager.downloadUpdateGame`, handleIncomingRequest);

async function handleIncomingRequest(request) {
  request = JSON.parse(request);
  log.debug('Incoming downloadUpdateGame request:', request);

  // First acquire a download lock
  try {
    log.debug(`Attempting to lock downloadManager-downloadUpdateGame-${request.gameId}`);
    await lockFile(`downloadManager-downloadUpdateGame-${request.gameId}`);
  } catch (error) {
    // eslint-disable-next-line no-prototype-builtins
    const isDownloadRunning = runningDownloads.hasOwnProperty(`${request.gameId}`);
    if (isDownloadRunning) {
      sendRequestReply('nack', runningDownloads[request.gameId], request);
      log.debug('Could not lock, sending NACK with currently running download');
    } else {
      sendRequestReply('error', error, request);
      log.debug('Could not lock, sending NACK with error');
    }
    return;
  }

  runningDownloads[request.gameId] = request.requestId;

  // Setup an output stream to forward logs through
  const outputSink = new Stream.PassThrough();

  // When it receives something, forward it to ipc
  outputSink.on('data', (data) => {
    data = data.toString();
    sendRequestReply('progress', data, request);
  });

  // Let everyone else know what we're doing
  setPingReply(moduleIdent, ipc, 'downloading');

  // Then ack the request
  sendRequestReply('ack', 'ack', request);

  var gameInfo = await loadManifest(request.gameId);
  var result = false;

  switch (gameInfo.downloadType) {
    case 'steamcmd':
      try {
        await steamCmdDownloadSelf(
          {
            force: request.steamCmdForce,
            steamCmdDir: request.steamCmdDir,
          },
          outputSink,
        );
        result = await steamCmdDownloadAppid(
          {
            appid: gameInfo.downloadID,
            serverFilesForce: request.serverFilesForce,
            validate: request.validate,
            anonymous: request.anonymous,
            username: request.username,
            password: request.password,
            steamCmdDir: request.steamCmdDir,
            serverFilesDir: request.serverFilesDir,
          },
          outputSink,
        );
        var replyText = '';
        if (result === 0) {
          replyText = 'completed';
        } else {
          replyText = result;
        }
        sendRequestReply('status', replyText, request);
        await unlockFile(`downloadManager-downloadUpdateGame-${request.gameId}`);
        return;
      } catch (error) {
        log.error(`Error while running steamcmd: ${error.toString()}`);
        sendRequestReply('error', error, request);
        await unlockFile(`downloadManager-downloadUpdateGame-${request.gameId}`);
        return;
      }
    default:
      sendRequestReply('error', new Error('unsupported request'), request);
      await unlockFile(`downloadManager-downloadUpdateGame-${request.gameId}`);
      break;
  }
}

async function sendRequestReply(channel, message, request) {
  const statusMsg = {
    requestId: request.requestId,
    moduleIdent: moduleIdent,
    timestamp: Date.now(),
    message: message.toString(),
    error: message instanceof Error ? true : false,
  };

  if (statusMsg.error) {
    if (message.message === 'SHUTDOWN') {
      setPingReply(moduleIdent, ipc, 'shutdown');
    } else {
      setPingReply(moduleIdent, ipc, 'error');
    }
  }

  ipc.publish(`${request.replyTo}.${channel}`, JSON.stringify(statusMsg));
}

/**
 * Load gameInfo manifest
 * @param {String} gameId - the gameId to load
 * @returns {Object} the gameInfo manifest
 */
async function loadManifest(gameId) {
  // Game info manifest (download type, etc)
  // eslint-disable-next-line node/no-unsupported-features/es-syntax
  const _manifest = await import(path.normalize(path.resolve(`${__dirname}/../manifests/${gameId}.mjs`)));
  const manifest = _manifest.manifest;
  return manifest;
}
