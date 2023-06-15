'use strict';

// Download manager

// Our libs
import { setupIpc, setPingReply } from '../lib/ipc.mjs';
import { lockFile, unlockFile } from '../lib/lockfile.mjs';
import { setupTerminationSignalHandlers } from '../lib/exitHandlers.mjs';
import { setupLog, isoTimestamp } from '../lib/log.mjs';
import { steamCmdDownloadSelf, steamCmdDownloadAppid } from '../lib/steamcmd.mjs';
import { getDirName } from '../lib/dirname.mjs';
import { parseBool } from '../lib/parseBool.mjs';

// Nodejs stdlib
import { default as fs } from 'node:fs';
import { default as Stream } from 'node:stream';
import { default as path } from 'node:path';

//
// Start boilerplate
const moduleIdent = 'downloadManager';

const supportedGames = ['csgo'];

// Populate __dirname
const __dirname = getDirName();

// Setup logger
const log = setupLog('bin/downloadManager.mjs');

// Flag start-of-log
log.info('honk.host gameserver manager v0.4.20');
log.info(`--- Logs begin at ${isoTimestamp()} ---`);

// Create our lockfile (throws if it fails)
await lockFile(moduleIdent);

// Setup our IPC "connection"
const ipc = await setupIpc(moduleIdent);

// Setup our termination handlers for SIGTERM and SIGINT
setupTerminationSignalHandlers(moduleIdent, ipc);

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

// Subscribe to downloadUpdateGame requests
ipc.subscribe('downloadManager.downloadUpdateGame', downloadUpdateGame);
// List running downloads
ipc.subscribe('downloadManager.listRunningDownloads', listRunningDownloads);

// Note: cancelDownload command handled below inside downloadUpdateGame();

//
// Functions

/**
 * Deal with incoming downloadUpdateGame requests
 * @param {Object.<String, Boolean>} request - the request as delivered by IPC
 * @param {String} request.requestId - uuidv4 - requestId
 * @param {String} request.replyTo - `${moduleIdent}.${requestId}`
 * @param {String} request.gameId - 'csgo'
 * @param {Boolean} request.validate - false
 * @param {Boolean} request.steamCmdForce - false
 * @param {String} request.steamCmdDir - '/opt/gsm/steamcmd'
 * @param {Boolean} request.serverFilesForce - false
 * @param {String} request.downloadDir - '/opt/gsm/csgo'
 * @param {Boolean} request.anonymous -  true
 * @param {String} request.username - ''
 * @param {String} request.password - ''
 * @param {Boolean} request.steamcmdMultiFactorEnabled - false
 * @returns {Void}
 */
async function downloadUpdateGame(request) {
  request = JSON.parse(request);
  log.info(`Incoming downloadUpdateGame request:`, request);

  // Verify caller provided an appid and we support downloading it
  if (!request.gameId) {
    log.error('handleIncomingRequest called without gameId, sending error');
    sendRequestReply('error', new Error('gameId required'), request);
    await unlockFile(`downloadManager-${request.gameId}`);
    return;
  }
  if (!supportedGames.includes(request.gameId)) {
    log.error('invalid appid requested');
    sendRequestReply('error', new Error('gameId unsupported'), request);
    await unlockFile(`downloadManager-${request.gameId}`);
    return;
  }

  // First acquire a download lock
  try {
    // Try to lock
    await lockFile(`downloadManager-${request.gameId}`);
  } catch (error) {
    // If it errors, check to see if a download is running for our game
    if (error.code == 'EEXIST') {
      // If so, send the NACK along with the channel id they can sub to for progress messages
      log.warn('Could not lock, sending NACK with currently running download');
      sendRequestReply(
        'nack',
        {
          alreadyRequested: true,
          reason: 'already requested',
          subscribeTo: runningDownloads[request.gameId].request.replyTo,
          requestId: runningDownloads[request.gameId].request.requestId,
          request: request,
        },
        request,
      );
      // And log a message
    } else {
      // Forward on other errors
      log.error('Could not lock, sending NACK with error', error);
      sendRequestReply('error', error, request);
    }
    return;
  }

  // We don't support multifactor (yet)
  // TODO multifactor auth
  if (request.steamcmdMultiFactorEnabled) {
    log.error('multifactor auth not supported');
    sendRequestReply('error', new Error('multifactor auth not supported'), request);
    await unlockFile(`downloadManager-${request.gameId}`);
    return;
  }

  // Push our in-progress download to our tracking object
  runningDownloads[request.gameId] = {
    request: request,
    gameId: request.gameId,
    downloadLocked: null,
    downloadState: null,
    lastLog: [],
    progressSnapshot: {},
    error: false,
  };
  runningDownloads[request.gameId].downloadLocked = true;
  runningDownloads[request.gameId].downloadState = 'preparing';

  // Load the gameInfo manifest
  try {
    var gameInfo = await loadManifest(request.gameId);
  } catch (error) {
    runningDownloads[request.gameId].error = error;
    sendRequestReply('error', error, request);
    await unlockFile(`downloadManager-${request.gameId}`);
    return;
  }

  // Prepare a variable to hold our download result
  var result = false;

  // Setup an output stream to forward logs through
  const outputSink = new Stream.PassThrough({ end: false });

  // And another for progress indicators
  const progressSink = new Stream.PassThrough({ end: false });

  // This one is for sending commands down to the download controller
  const commandSink = new Stream.PassThrough({ end: false });

  // When it receives something, forward it to ipc
  outputSink.on('data', (data) => {
    const output = data.toString();
    runningDownloads[request.gameId].lastLog.unshift(output);
    runningDownloads[request.gameId].lastLog.length = Math.min(runningDownloads[request.gameId].lastLog.length, 1000);
    sendRequestReply('output', output, request);
  });

  // Ditto for progress indicators
  progressSink.on('data', (data) => {
    const progress = JSON.parse(data);
    runningDownloads[request.gameId].progressSnapshot = progress;
    runningDownloads[request.gameId].downloadState = 'running';
    sendRequestReply('progress', progress, request);
    setPingReply(moduleIdent, ipc, `${progress.downloadState} ${progress.downloadProgress}`);
  });

  // Let everyone else know what we're doing
  setPingReply(moduleIdent, ipc, 'preparing');

  // Then ack the request
  sendRequestReply(
    'ack',
    {
      subscribeTo: request.replyTo,
      requestId: request.requestId,
    },
    request,
  );

  // Subscribe to cancel download messages
  ipc.subscribe(`${moduleIdent}.${request.requestId}.cancelDownload`, (cancelRequest) => {
    cancelRequest = JSON.parse(cancelRequest);
    log.warn('cancelDownload request received:', cancelRequest);

    // Tell the download handler to cancel the request
    commandSink.push(
      JSON.stringify({
        command: 'cancel',
      }),
    );

    commandSink.on('data', (response) => {
      response = JSON.parse(response);
      if (response.status === 'ackCanceled') {
        // Build response object
        const response = {
          status: 'canceled',
          error: false,
        };

        // If cleanup is specified, rm the incomplete files
        if (cancelRequest.message.cleanup) {
          log.warn('cancelRequest.cleanup is true, removing incomplete files!');
          try {
            fs.rmSync(request.downloadDir, { recursive: true, force: true });
            response.cleanup = 'successful';
          } catch (error) {
            log.error(error);
            response.error = error;
            response.cleanup = 'failed';
          }
        }

        // Tell the 3rd party who asked for the cancel that we did
        sendRequestReply('finalStatus', response, {
          requestId: request.requestId,
          replyTo: cancelRequest.replyTo,
        });

        // Cleanup/Unsubscribe from further cancel requests
        ipc.unsubscribe(`${moduleIdent}.${request.requestId}.cancelDownload`);
        runningDownloads[request.gameId].downloadLocked = false;
        runningDownloads[request.gameId].downloadState = 'canceled';
        commandSink.removeAllListeners();
        return;
      }
    });
  });

  // Steamcmd, direct, etc?
  switch (gameInfo.downloadType) {
    case 'steamcmd':
      try {
        // Make sure steamcmd itself is downloaded
        await steamCmdDownloadSelf({
          force: request.steamCmdForce,
          steamCmdDir: request.steamCmdDir,
          steamcmdMultiFactorEnabled: request.steamcmdMultiFactorEnabled,
        });

        // Then download/update the game
        result = await steamCmdDownloadAppid(
          {
            appid: gameInfo.downloadID,
            serverFilesForce: request.serverFilesForce,
            validate: request.validate,
            anonymous: request.anonymous,
            username: request.username,
            password: request.password,
            steamCmdDir: request.steamCmdDir,
            downloadDir: request.downloadDir,
            steamcmdMultiFactorEnabled: request.steamcmdMultiFactorEnabled,
          },
          // Passing through a Stream.Writable for steamcmd stdout and progress indication
          outputSink,
          progressSink,
          // And another for commands
          commandSink,
        );

        // Send a final reply to the request
        sendRequestReply('finalStatus', result, request);

        // Unsubscribe from cancel requests
        ipc.unsubscribe(`${moduleIdent}.${request.requestId}.cancelDownload`);

        // Pull our in-progress download from our tracking object
        runningDownloads[request.gameId].downloadLocked = false;

        // Tell everyone we're ready again
        setPingReply(moduleIdent, ipc, 'ready');

        // And unlock
        await unlockFile(`downloadManager-${request.gameId}`);
        return;
      } catch (error) {
        if (error != null) {
          // Log and reply with the error
          log.error('Error while running steamcmd:', error);
          runningDownloads[request.gameId].downloadState = 'error';
          runningDownloads[request.gameId].error = error;
          ipc.unsubscribe(`${moduleIdent}.${request.requestId}.cancelDownload`);
          sendRequestReply('error', error, request);
          setPingReply(moduleIdent, ipc, 'error');
          // Unlock and return
          await unlockFile(`downloadManager-${request.gameId}`);
          return;
        } else {
          log.error('Unknown error from steamcmd!', error);
          return;
        }
      }
    default:
      // We don't know how to download this!
      // Tell the orig. caller we errored out
      sendRequestReply('error', new Error('unsupported request'), request);
      // Set our ping listener to error
      setPingReply(moduleIdent, ipc, 'error - unsupported request');
      // Unsub from cancel download requests
      ipc.unsubscribe(`${moduleIdent}.${request.requestId}.cancelDownload`);
      // Unlock and return
      await unlockFile(`downloadManager-${request.gameId}`);
      return;
  }
}

/**
 * List running downloads
 * @param {Object} request - the request as delivered by IPC
 */
async function listRunningDownloads(request) {
  request = JSON.parse(request);
  const list = {
    requestId: request.requestId,
    moduleIdent: moduleIdent,
    timestamp: Date.now(),
    message: runningDownloads,
  };

  await ipc.publish(`${request.replyTo}`, JSON.stringify(list));
}

/**
 * Sends a reply to the initial request on a given channel
 * @param {String} channel - the subchannel to message
 * @param {String} message - the message to send as reply.message
 * @param {Object} request - the initial request object
 */
async function sendRequestReply(channel, message, request) {
  // Build the status message
  const statusMsg = {
    requestId: request.requestId,
    moduleIdent: moduleIdent,
    timestamp: Date.now(),
    message: message instanceof Error ? message.message.toString() : message,
    error: message instanceof Error ? true : false,
  };

  // Fire off the reply (hopefully they're listening)
  await ipc.publish(`${request.replyTo}.${channel}`, JSON.stringify(statusMsg));
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
