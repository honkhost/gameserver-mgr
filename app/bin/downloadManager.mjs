'use strict';

// Download manager

// Our libs
import { setupIpc, setPingReply, sendRequestReply } from '../lib/ipc.mjs';
import { lockFile, unlockFile, isLocked, checkLockPath } from '../lib/lockfile.mjs';
import { setupTerminationSignalHandlers } from '../lib/exitHandlers.mjs';
import { setupLog, isoTimestamp } from '../lib/log.mjs';
import { steamCmdDownloadSelf, steamCmdDownloadAppid } from '../lib/steamcmd.mjs';
import { getDirName } from '../lib/dirname.mjs';
import { parseBool } from '../lib/parseBool.mjs';

// Nodejs stdlib
import { default as fs } from 'node:fs';
import { default as Stream } from 'node:stream';
import { default as path } from 'node:path';
import { default as crypto } from 'node:crypto';

//
// Start boilerplate
// Debug modes
const debug = parseBool(process.env.DEBUG) || false;

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

// Subscribe to cancel download messages
ipc.subscribe(`${moduleIdent}.cancelDownload`, (cancelRequest) => {
  cancelRequest = JSON.parse(cancelRequest);
  log.warn('cancelDownload request received:', cancelRequest);

  // If the appid in the request is in our runningDownloads
  // eslint-disable-next-line no-prototype-builtins
  if (cancelRequest.message.gameIdToCancel in runningDownloads) {
    log.warn(`Attempting to cancel download for ${cancelRequest.message.gameIdToCancel}`);
    // Tell the download handler to cancel the request
    runningDownloads[cancelRequest.message.gameIdToCancel].commandSink.push(
      JSON.stringify({
        command: 'cancel',
      }),
    );

    // Listen for a response
    runningDownloads[cancelRequest.message.gameIdToCancel].commandSink.on('data', (response) => {
      response = JSON.parse(response);
      // If it canceled okay
      if (response.status === 'ackCanceled') {
        // Build response object
        const response = {
          status: 'canceled',
          error: false,
        };
        // If cleanup is specified, rm the incomplete files
        if (cancelRequest.message.cleanup) {
          log.warn('cancelRequest.cleanup is true, removing incomplete files!');
          // The actual rm
          try {
            fs.rmSync(runningDownloads[cancelRequest.message.gameIdToCancel].request.message.downloadDir, {
              recursive: true,
              force: true,
            });
            // Set status message
            response.cleanup = 'successful';
          } catch (error) {
            log.error(error);
            response.error = error;
            response.cleanup = 'failed';
          }
        }
        // Tell the 3rd party who asked for the cancel that we did
        sendRequestReply(moduleIdent, ipc, 'finalStatus', response, {
          requestId: cancelRequest.requestId,
          replyTo: cancelRequest.replyTo,
        });
        // Cleanup/Unsubscribe from further cancel requests
        ipc.unsubscribe(`${moduleIdent}.${cancelRequest.requestId}.cancelDownload`);
        // Probably not necessary
        runningDownloads[cancelRequest.message.gameIdToCancel].commandSink.removeAllListeners();
        // Zero out the runningDownloads object for this appid
        runningDownloads[cancelRequest.message.gameIdToCancel] = {};
        return;
      }
    });
  }
});

//
// Functions

/**
 * Deal with incoming downloadUpdateGame requests
 * @param {Object.<String, Boolean>} request - the request as delivered by IPC
 * @param {String} request.requestId - uuidv4 - requestId
 * @param {String} request.replyTo - `${moduleIdent}.${requestId}`
 * @param {Object.<String, Boolean>} request.message - actual request
 * @param {String} request.message.gameId - 'csgo'
 * @param {Boolean} request.message.validate - false
 * @param {Boolean} request.message.steamCmdForce - false
 * @param {String} request.message.steamCmdDir - '/opt/gsm/steamcmd'
 * @param {Boolean} request.message.serverFilesForce - false
 * @param {String} request.message.downloadDir - '/opt/gsm/csgo'
 * @param {Boolean} request.message.anonymous -  true
 * @param {String} request.message.username - ''
 * @param {String} request.message.password - ''
 * @param {Boolean} request.message.steamcmdMultiFactorEnabled - false
 * @returns {Void}
 */
async function downloadUpdateGame(request) {
  request = JSON.parse(request);
  log.info('Incoming downloadUpdateGame request:', request);

  // Verify caller provided an appid and we support downloading it
  if (!request.message.gameId) {
    log.error('handleIncomingRequest called without gameId, sending error');
    sendRequestReply(moduleIdent, ipc, 'error', new Error('gameId required'), request);
    return;
  }
  if (!supportedGames.includes(request.message.gameId)) {
    log.error('invalid appid requested');
    sendRequestReply(moduleIdent, ipc, 'error', new Error('gameId unsupported'), request);
    return;
  }

  // Early status message - our runningDownloads object doesn't exist yet
  var earlyState = 'checking locks';

  // Load the gameInfo manifest
  try {
    var gameInfo = await loadManifest(request.message.gameId);
  } catch (error) {
    // Tell the requester we errored out
    sendRequestReply(moduleIdent, ipc, 'error', error, request);
    // And unlock
    await unlockFile(`downloadGame-${request.message.gameId}`);
    return;
  }

  // First acquire a download lock
  try {
    // Try to acquire a lock for this particular game download
    await lockFile(`downloadGame-${request.gameId}`);
    // If we can lock, push our in-progress download to our tracking object
    runningDownloads[request.message.gameId] = {
      request: request,
      gameId: request.message.gameId,
      downloadId: gameInfo.downloadId,
      downloadLocked: true,
      downloadState: earlyState,
      lastLog: [],
      progressSnapshot: {},
      error: null,
    };
  } catch (error) {
    // If it errors, check to see if a download is running for our game
    if (error.code == 'EEXIST' && request.gameId in runningDownloads) {
      // If so, send the NACK along with the channel id they can sub to for progress messages
      log.warn(`Could not lock downloadGame-${request.gameId} & download appears to be in progress, sending NACK`);
      // Tell the caller it's already running along with the channel to watch for progress
      sendRequestReply(
        moduleIdent,
        ipc,
        'nack',
        {
          alreadyRequested: true,
          alreadyMounted: false,
          reason: 'already requested',
          subscribeTo: runningDownloads[request.message.gameId].request.replyTo,
          requestId: runningDownloads[request.message.gameId].request.requestId,
          request: runningDownloads[request.message.gameId].request,
        },
        request,
      );
      return;
    } else {
      // Forward on other errors
      log.error('Could not lock, sending error', error);
      // Tell the caller
      sendRequestReply(moduleIdent, ipc, 'error', error, request);
      // Unlock
      await unlockFile(`downloadGame-${request.message.gameId}`);
      return;
    }
  }

  // Check to see if any 'baseMount-${gameId}-.* files exist in the lockpath
  // Wait a few if they're still there
  // We might've gotten an update req before the gameserver is done being torn down
  try {
    // Check again N times
    var retriesBaseMountLock = 10;
    // eslint-disable-next-line no-constant-condition
    while (await isLocked(`^baseMount-${request.message.gameId}-.*$`)) {
      // Decrease our retry counter
      retriesBaseMountLock--;
      // If we're out of retries
      if (retriesBaseMountLock === 0) {
        log.error(`Timeout waiting for locks to clear on ${request.message.gameId}, sending NACK`);
        // Nack the request
        sendRequestReply(
          moduleIdent,
          ipc,
          'nack',
          {
            alreadyRequested: false,
            alreadyMounted: true,
            reason: `${request.message.gameId} base files still mounted`,
            subscribeTo: false,
            requestId: false,
            request: request,
          },
          request,
        );
        // Unlock and return
        await unlockFile(`downloadGame-${request.message.gameId}`);
        return;
      }
      // And log
      log.warn(`Base files appear to be locked for ${request.message.gameId}, sleeping`);

      // Sleep a few seconds
      await new Promise((resolve, reject) => {
        return setTimeout(resolve, 2000);
      });
    }
  } catch (error) {
    // Forward on other errors
    log.error('Could not check for baseMount locks, sending error', error);
    // Tell the caller
    sendRequestReply(moduleIdent, ipc, 'error', error, request);
    // And unlock
    await unlockFile(`downloadGame-${request.message.gameId}`);
    return;
  }

  // Log current status
  runningDownloads[request.message.gameId].downloadState = 'preparing';

  // We don't support multifactor (yet)
  // TODO multifactor auth
  if (request.message.steamcmdMultiFactorEnabled) {
    log.error('multifactor auth not supported');
    sendRequestReply(moduleIdent, ipc, 'error', new Error('multifactor auth not supported'), request);
    await unlockFile(`downloadGame-${request.message.gameId}`);
    return;
  }

  // Prepare a variable to hold our download result
  var result = false;

  // Setup an output stream to forward logs through
  runningDownloads[request.message.gameId].outputSink = new Stream.PassThrough({ end: false });
  // And another for progress indicators
  runningDownloads[request.message.gameId].progressSink = new Stream.PassThrough({ end: false });
  // This one is for sending commands down to the download controller
  runningDownloads[request.message.gameId].commandSink = new Stream.PassThrough({ end: false });

  // When it receives something, forward it to ipc
  runningDownloads[request.message.gameId].outputSink.on('data', (data) => {
    const output = data.toString();
    // Add the line to lastLog
    runningDownloads[request.message.gameId].lastLog.unshift(output);
    // Truncate lastLog
    runningDownloads[request.message.gameId].lastLog.length = Math.min(
      runningDownloads[request.message.gameId].lastLog.length,
      1000,
    );
    // Tell the caller we have some output
    sendRequestReply(moduleIdent, ipc, 'output', output, request);
  });

  // Ditto for progress indicators
  runningDownloads[request.message.gameId].progressSink.on('data', (data) => {
    const progress = JSON.parse(data);
    // Put a progress snapshot in runningDownloads
    runningDownloads[request.message.gameId].progressSnapshot = progress;
    // Update state
    runningDownloads[request.message.gameId].downloadState = 'running';
    // Tell the caller we have progress
    sendRequestReply(moduleIdent, ipc, 'progress', progress, request);
  });

  // Let everyone else know what we're doing
  setPingReply(moduleIdent, ipc, 'downloading');

  // Then ack the request
  sendRequestReply(
    moduleIdent,
    ipc,
    'ack',
    {
      subscribeTo: request.replyTo,
      requestId: request.requestId,
    },
    request,
  );

  // Steamcmd, direct, etc?
  switch (gameInfo.downloadType) {
    case 'steamcmd':
      try {
        // Make sure steamcmd itself is downloaded
        await steamCmdDownloadSelf({
          force: request.message.steamCmdForce,
          steamCmdDir: request.message.steamCmdDir,
          steamcmdMultiFactorEnabled: request.message.steamcmdMultiFactorEnabled,
        });

        // Then download/update the game
        result = await steamCmdDownloadAppid(
          {
            appid: gameInfo.downloadId, // steam appid
            serverFilesForce: request.message.serverFilesForce, // rm -rf server files before download
            validate: request.message.validate, // validate files after download
            anonymous: request.message.anonymous, // login anon
            username: request.message.username, // login username
            password: request.message.password, // login pass
            steamCmdDir: request.message.steamCmdDir, // dir to save/access steamcmd
            downloadDir: request.message.downloadDir, // dir to save server files
            steamcmdMultiFactorEnabled: request.message.steamcmdMultiFactorEnabled, // TODO: 2fa
          },
          // Passing through a Stream.Writable for steamcmd stdout and progress indication
          runningDownloads[request.message.gameId].outputSink,
          runningDownloads[request.message.gameId].progressSink,
          // And another for commands
          runningDownloads[request.message.gameId].commandSink,
        );

        // Flag that we're unlocked
        runningDownloads[request.message.gameId].downloadLocked = false;
        // And a final state update
        runningDownloads[request.message.gameId].downloadState = result.status;

        // Send a final reply to the request
        sendRequestReply(moduleIdent, ipc, 'finalStatus', result, request);

        // Unsubscribe from cancel requests
        ipc.unsubscribe(`${moduleIdent}.${request.message.requestId}.cancelDownload`);

        // Pull our in-progress download from our tracking object
        runningDownloads[request.message.gameId].downloadLocked = false;

        // Tell everyone we're ready again
        setPingReply(moduleIdent, ipc, 'ready');

        // And unlock
        await unlockFile(`downloadGame-${request.message.gameId}`);
        runningDownloads[request.message.gameId] = {};
        return;
      } catch (error) {
        if (error != null) {
          // Log and reply with the error
          log.error('Error while running steamcmd:', error);
          ipc.unsubscribe(`${moduleIdent}.${request.message.requestId}.cancelDownload`);
          sendRequestReply(moduleIdent, ipc, 'error', error, request);
          setPingReply(moduleIdent, ipc, 'error');
          // Unlock and return
          await unlockFile(`downloadGame-${request.message.gameId}`);
          runningDownloads[request.message.gameId] = {};
          return;
        } else {
          // Some other non-error, ignore it (steamcmd is good at this)
          log.error('Unknown error from steamcmd!', error);
          return;
        }
      }
    default:
      // We don't know how to download this!
      // Tell the orig. caller we errored out
      sendRequestReply(moduleIdent, ipc, 'error', new Error('unsupported request'), request);
      // Set our ping listener to error
      setPingReply(moduleIdent, ipc, 'error - unsupported request');
      // Unlock and return
      await unlockFile(`downloadGame-${request.message.gameId}`);
      // Blank out the status object
      runningDownloads[request.message.gameId] = {};
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
 * Load gameInfo manifest
 * @param {String} gameId - the gameId to load
 * @returns {Object} the gameInfo manifest
 */
async function loadManifest(gameId) {
  // Game info manifest (download type, etc)
  // eslint-disable-next-line node/no-unsupported-features/es-syntax
  const _manifest = await import(path.resolve(`${__dirname}/../manifests/${gameId}.mjs`));
  const manifest = _manifest.manifest;
  return manifest;
}
