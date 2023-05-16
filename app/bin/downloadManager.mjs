'use strict';

// Download manager

// Our libs
import { setupIpc, setPingReply, sendRequestReply } from '../lib/ipc.mjs';
import { releaseLock, spinLock, spinClear } from '../lib/lock.mjs';
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
// Debug modes
const debug = parseBool(process.env.DEBUG) || false;

const moduleIdent = 'downloadManager';

const supportedGames = ['csgo'];

// Populate __dirname
const __dirname = getDirName();

// Setup logger
const log = setupLog('bin/downloadManager.mjs');

// Flag start-of-log
log.info('honk.host gameserver download manager v0.4.20');
log.info(`--- Logs begin at ${isoTimestamp()} ---`);

// Setup our IPC "connection"
const ipc = await setupIpc(moduleIdent);

// Setup our termination handlers for SIGTERM and SIGINT
setupTerminationSignalHandlers(moduleIdent, ipc);

// Create our lockfile (throws if it fails)
await spinLock(moduleIdent, 30);

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

// downloadUpdateGame requests
ipc.subscribe('downloadManager.downloadUpdateGame', downloadUpdateGame);
// List running downloads
ipc.subscribe('downloadManager.listRunningDownloads', listRunningDownloads);
// Cancel download messages
ipc.subscribe(`${moduleIdent}.cancelDownload`, cancelDownload);

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
async function downloadUpdateGame(ipcData) {
  const request = JSON.parse(ipcData);
  if (debug) log.debug('Incoming downloadUpdateGame request:', request);

  // Verify caller provided an appid and we support downloading it
  if (!request.gameId) {
    log.error('handleIncomingRequest called without gameId, sending error');
    sendRequestReply(moduleIdent, ipc, 'error', { error: new Error('gameId required') }, request);
    return;
  }
  if (!supportedGames.includes(request.gameId)) {
    log.error('invalid appid requested');
    sendRequestReply(moduleIdent, ipc, 'error', { error: new Error('gameId unsupported') }, request);
    return;
  }

  // Used below
  // Global "we're downloading stuff" lock
  const globalLockId = `downloadGame-${request.gameId}`;
  // Pattern to check for spinClear below
  const baseMountLockCheckPattern = `^baseMount-${request.gameId}-.*$`;

  // Early status message - our runningDownloads object doesn't exist yet
  var earlyState = 'checking locks';

  // Load the gameInfo manifest
  try {
    var gameInfo = await loadManifest(request.gameId);
  } catch (error) {
    // Tell the requester we errored out
    sendRequestReply(moduleIdent, ipc, 'error', { error: error.message }, request);
    // And unlock
    await releaseLock(globalLockId);
    return;
  }

  if (request.gameId in runningDownloads) {
    // If so, send the NACK along with the channel id they can sub to for progress messages
    log.warn(`Download appears to be in progress for ${request.gameId}, sending NACK`);
    // Tell the caller it's already running along with the channel to watch for progress
    sendRequestReply(
      moduleIdent,
      ipc,
      'nack',
      {
        alreadyRequested: true,
        alreadyMounted: null,
        reason: 'already requested',
        subscribeTo: runningDownloads[request.gameId].request.replyTo,
        requestId: runningDownloads[request.gameId].request.requestId,
        request: runningDownloads[request.gameId].request,
      },
      request,
    );
    return;
  } else {
    // Create the status tracking object
    runningDownloads[request.gameId] = {
      request: request,
      gameId: request.gameId,
      downloadId: gameInfo.downloadId,
      downloadLocked: true,
      downloadState: earlyState,
      lastLog: [],
      progressSnapshot: {},
      error: null,
    };
  }

  // First acquire a config download lock for the instance
  try {
    await spinLock(globalLockId, 30);
  } catch (error) {
    log.error(`Error while spinLocking on ${globalLockId}`, error);
    delete runningDownloads[request.gameId];
    sendRequestReply(moduleIdent, ipc, 'error', { error: error.message }, request);
    return;
  }

  // Check to see if any 'baseMount-${gameId}-.* files exist in the lockpath
  // Wait a few if they're still there
  // We might've gotten an update req before the gameserver is done being torn down
  try {
    // Spinlock on our "base files are mounted somewhere" pattern
    await spinClear(baseMountLockCheckPattern, 30);
  } catch (error) {
    // We keep globalLockId active - manual cleanup may be required on an unknown error condition
    log.error(`Error while spinClearing on ${baseMountLockCheckPattern}`, error);
    sendRequestReply(moduleIdent, ipc, 'error', { error: error.message }, request);
    delete runningDownloads[request.gameId];
    await releaseLock(globalLockId);
    return;
  }

  // Log current status
  runningDownloads[request.gameId].downloadState = 'preparing';

  // We don't support multifactor (yet)
  // TODO multifactor auth
  if (request.steamcmdMultiFactorEnabled) {
    log.error('multifactor auth not supported');
    sendRequestReply(moduleIdent, ipc, 'error', { error: 'multifactor auth not supported' }, request);
    delete runningDownloads[request.gameId];
    await releaseLock(globalLockId);
    return;
  }

  // Prepare a variable to hold our download result
  var result = false;

  // Setup an output stream to forward logs through
  runningDownloads[request.gameId].outputSink = new Stream.PassThrough({ end: false });
  // And another for progress indicators
  runningDownloads[request.gameId].progressSink = new Stream.PassThrough({ end: false });
  // This one is for sending commands down to the download controller
  runningDownloads[request.gameId].commandSink = new Stream.PassThrough({ end: false });

  // When it receives something, forward it to ipc
  runningDownloads[request.gameId].outputSink.on('data', (data) => {
    const output = data.toString();
    // Add the line to lastLog
    runningDownloads[request.gameId].lastLog.unshift(output);
    // Truncate lastLog
    runningDownloads[request.gameId].lastLog.length = Math.min(runningDownloads[request.gameId].lastLog.length, 1000);
    // Tell the caller we have some output
    sendRequestReply(moduleIdent, ipc, 'output', { line: output }, request);
  });

  // Ditto for progress indicators
  runningDownloads[request.gameId].progressSink.on('data', (data) => {
    const progress = JSON.parse(data);
    // Put a progress snapshot in runningDownloads
    runningDownloads[request.gameId].progressSnapshot = progress;
    // Update state
    runningDownloads[request.gameId].downloadState = 'running';
    // Tell the caller we have progress
    sendRequestReply(moduleIdent, ipc, 'progress', { line: progress }, request);
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

  // Steamcmd, TODO: direct, etc?
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
            appid: gameInfo.downloadId, // steam appid
            serverFilesForce: request.serverFilesForce, // rm -rf server files before download
            validate: request.validate, // validate files after download
            anonymous: request.anonymous, // login anon
            username: request.username, // login username
            password: request.password, // login pass
            steamCmdDir: request.steamCmdDir, // dir to save/access steamcmd
            downloadDir: request.downloadDir, // dir to save server files
            steamcmdMultiFactorEnabled: request.steamcmdMultiFactorEnabled, // TODO: 2fa
          },
          // Passing through a Stream.Writable for steamcmd stdout and progress indication
          runningDownloads[request.gameId].outputSink,
          runningDownloads[request.gameId].progressSink,
          // And another for commands
          runningDownloads[request.gameId].commandSink,
        );

        // Flag that we're unlocked
        runningDownloads[request.gameId].downloadLocked = false;
        // And a final state update
        runningDownloads[request.gameId].downloadState = result.status;

        // Send a final reply to the request
        sendRequestReply(moduleIdent, ipc, 'finalStatus', result, request);

        // Unsubscribe from cancel requests
        ipc.unsubscribe(`${moduleIdent}.${request.requestId}.cancelDownload`);

        // Pull our in-progress download from our tracking object
        runningDownloads[request.gameId].downloadLocked = false;

        // Tell everyone we're ready again
        setPingReply(moduleIdent, ipc, 'ready');

        // And unlock
        await releaseLock(globalLockId);
        delete runningDownloads[request.gameId];
        return;
      } catch (error) {
        if (error != null) {
          // Log and reply with the error
          log.error('Error while running steamcmd:', error);
          ipc.unsubscribe(`${moduleIdent}.${request.requestId}.cancelDownload`);
          sendRequestReply(moduleIdent, ipc, 'error', { error: error.message }, request);
          setPingReply(moduleIdent, ipc, 'error');
          // Unlock and return
          await releaseLock(globalLockId);
          runningDownloads[request.gameId] = {};
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
      sendRequestReply(moduleIdent, ipc, 'error', { error: new Error('unsupported request') }, request);
      // Set our ping listener to error
      setPingReply(moduleIdent, ipc, 'error - unsupported request');
      // Unlock and return
      await releaseLock(globalLockId);
      // Blank out the status object
      runningDownloads[request.gameId] = {};
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
    runningDownloads: runningDownloads,
  };

  await ipc.publish(`${request.replyTo}`, JSON.stringify(list));
}

async function cancelDownload(data) {
  const cancelRequest = JSON.parse(data);

  log.warn('cancelDownload request received:', cancelRequest);
  // If the appid in the request is in our runningDownloads
  // eslint-disable-next-line no-prototype-builtins
  if (cancelRequest.gameIdToCancel in runningDownloads) {
    log.warn(`Attempting to cancel download for ${cancelRequest.gameIdToCancel}`);
    // Tell the download handler to cancel the request
    runningDownloads[cancelRequest.gameIdToCancel].commandSink.push(
      JSON.stringify({
        command: 'cancel',
      }),
    );

    // Listen for a response
    runningDownloads[cancelRequest.gameIdToCancel].commandSink.on('data', (response) => {
      response = JSON.parse(response);
      // If it canceled okay
      if (response.status === 'ackCanceled') {
        // Build response object
        const response = {
          status: 'canceled',
          error: false,
        };
        // If cleanup is specified, rm the incomplete files
        if (cancelRequest.cleanup) {
          log.warn('cancelRequest.cleanup is true, removing incomplete files!');
          // The actual rm
          try {
            fs.rmSync(runningDownloads[cancelRequest.gameIdToCancel].request.downloadDir, {
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
        runningDownloads[cancelRequest.gameIdToCancel].commandSink.removeAllListeners();
        // Zero out the runningDownloads object for this appid
        runningDownloads[cancelRequest.gameIdToCancel] = {};
        return;
      }
    });
  }
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
