'use strict';

// Global Coordinator

// Our libs
import { setupIpc, setPingReply } from '../lib/ipc.mjs';
import { lockFile, unlockFile } from '../lib/lockfile.mjs';
import { setupTerminationSignalHandlers, exit } from '../lib/exitHandlers.mjs';
import { setupLog, isoTimestamp } from '../lib/log.mjs';
import { getDirName } from '../lib/dirname.mjs';

// Nodejs stdlib
import { default as Stream } from 'node:stream';
import { default as path } from 'node:path';
import { default as crypto } from 'node:crypto';

//
// Start boilerplate
const moduleIdent = 'lifecycleManager';

// Populate __dirname
const __dirname = getDirName();

// Setup logger
const log = setupLog('bin/lifecycleManager.mjs');

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

// Steamcmd install directory
const _steamCmdDir = process.env.STEAMCMD_DIR || '/opt/gsm/steamcmd';
const steamCmdDir = path.resolve(path.normalize(_steamCmdDir));

// Server files directory
const _serverFilesDir = process.env.SERVER_FILES_DIR || '/opt/gsm/gamefiles';
const serverFilesDir = path.resolve(path.normalize(_serverFilesDir));

// Pull gameID from ennvvars
const gameId = process.env.GAME_ID || 'csgo';

// Keep track of other modules
const moduleStatus = {
  downloadManager: 'unknown',
};

// setIntervals so we can clear them at shutdown
const intervals = {
  pingListeners: null,
  waitDownloadManagerAvailablePing: null,
};

// SIGTERM/SIGINT traps
process.once('SIGINT', () => {
  clearInterval(intervals.pingListeners);
  clearInterval(intervals.waitDownloadManagerAvailablePing);
});
process.once('SIGTERM', () => {
  clearInterval(intervals.pingListeners);
  clearInterval(intervals.waitDownloadManagerAvailablePing);
});

//
// Start logic
// When the ipc is setup, start doing things
ipc.on('start', async () => {
  // Tell everyone we're alive
  setPingReply(moduleIdent, ipc, 'running');

  // Fire off broadcast pings to detect module status
  // setupPingListeners();

  // Wait for downloadManager to be available
  try {
    await waitDownloadManagerAvailable({ timeout: 30 });
  } catch (error) {
    log.error('Timeout waiting for downloadManager, exiting...');
    exit(moduleIdent, ipc, 2);
  }

  /*
      options = {
        timeout: 30,
        gameId: '740',
        validate: false,
        steamCmdForce: false,
        serverFilesForce: false,
        anonymous: true,
        username: '',
        password: '',
      }
  */
  // Ask downloadManager to download and then wait for it to finish
  try {
    await downloadUpdateGame({
      gameId: gameId,
      validate: true,
      steamCmdForce: process.env.STEAMCMD_FILES_FORCE || false,
      serverFilesForce: process.env.SERVER_FILES_FORCE || false,
      anonymous: true,
      steamCmdDir: steamCmdDir,
      serverFilesDir: serverFilesDir,
    });
  } catch (error) {
    log.error(`Error downloading ${gameId}`, error);
  }

  // Ask repoManager to download configs from git

  // Ask overlayManager to setup the overlays

  // Ask gameManager to start the game

  // Lifecycle setup
});

//
// Functions

/**
 * Setup listeners for ping events
 * @returns {Void}
 */
function setupPingListeners() {
  // Send a ping on an interval
  const ping = {
    msgId: crypto.randomUUID(),
  };
  intervals.pingListeners = setInterval(() => {
    ipc.publish('_broadcast.ping', JSON.stringify(ping));
  }, 1000);

  // Listen for replies, update status object
  ipc.subscribe('_broadcast.pong', (data) => {
    const pong = JSON.parse(data);
    moduleStatus[pong.moduleIdent] = pong;
  });
}

/**
 * Resolve when downloadManager is available and ready
 * @param {Number} timeout - seconds to wait for downloadManager readiness
 * @returns {Promise<Void>} resolves when downloadManager is ready, rejects when timeout is exceeded
 */
function waitDownloadManagerAvailable(options = { timeout: 30 }) {
  return new Promise((resolve, reject) => {
    var pingCounter = 0;

    const msgId = crypto.randomUUID();

    intervals.waitDownloadManagerAvailablePing = setInterval(() => {
      // Increment a counter (timeout waiting for downloadManager)
      pingCounter++;
      // If the counter gets too high, reject with timeout
      if (pingCounter >= options.timeout) {
        clearInterval(intervals.waitDownloadManagerAvailablePing);
        return reject(new Error('Timeout exceeded'));
      }

      // Send ping
      const pingRequest = {
        msgId: msgId,
        replyTo: `${moduleIdent}.${msgId}.pong`,
      };
      ipc.publish('downloadManager.ping', JSON.stringify(pingRequest));
    }, 1000);

    // Act on replies
    ipc.subscribe(`${moduleIdent}.${msgId}.pong`, (data) => {
      // Parse the reply
      const pingReply = JSON.parse(data);

      // If it's running and ready
      if (pingReply.uptime >= 5) {
        // Clear our ping interval from above
        clearInterval(intervals.waitDownloadManagerAvailablePing);
        ipc.unsubscribe(`${msgId}.pong`);
        return resolve();
      }
    });
  });
}

/**
 * Download/update a game, resolve when done
 * @param {Object} options - download options
 * @returns {Promise<Void>} resolves when download is completed
 */
function downloadUpdateGame(
  options = {
    timeout: 30,
    gameId: '740',
    validate: false,
    steamCmdForce: false,
    serverFilesForce: false,
    steamCmdDir: '',
    serverFilesDir: '',
    anonymous: true,
    username: '',
    password: '',
  },
) {
  return new Promise((resolve, reject) => {
    // Send download request
    const requestId = crypto.randomUUID();

    const request = {
      requestId: requestId,
      replyTo: `${moduleIdent}.${requestId}`,
      gameId: gameId,
      validate: options.validate,
      steamCmdForce: options.steamCmdForce,
      steamCmdDir: options.steamCmdDir,
      serverFilesForce: options.serverFilesForce,
      serverFilesDir: options.serverFilesDir,
      anonymous: options.anonymous,
    };

    log.info(`Sending request for ${request.gameId} to the download manager`);
    ipc.publish(`downloadManager.downloadUpdateGame`, JSON.stringify(request));

    ipc.subscribe(`${moduleIdent}.${request.requestId}.error`, (response) => {
      response = JSON.parse(response);
      log.error(`Error while downloading ${request.gameId}: ${JSON.stringify(response, null, 2)}`);
      return reject(new Error(response.message));
    });

    ipc.subscribe(`${moduleIdent}.${request.requestId}.status`, (status) => {
      status = JSON.parse(status);
      log.info(`Download status update for ${request.gameId}: ${JSON.stringify(status.message, null, 2)}`);
      if (status.message === 'completed') {
        log.debug(status.message);
        // Do something
        ipc.unsubscribe(`${moduleIdent}.${request.requestId}.error`);
        ipc.unsubscribe(`${moduleIdent}.${request.requestId}.status`);
        return resolve(status);
      }
    });

    // Subscribe to progress reports
    const progressSink = new Stream.PassThrough({ end: false });
    watchDownloadProgress(request, progressSink);
    // Timeout if one doesn't show up for a while
    // Resolve when completed
  });
}

// Subscribe to progress reports
function watchDownloadProgress(request, progressSink) {
  ipc.subscribe(`${moduleIdent}.${request.requestId}.ack`, (data) => {
    const ack = JSON.parse(data);
    log.info(`Download manager ACK request for ${request.gameId}:`, ack);
  });

  ipc.subscribe(`${moduleIdent}.${request.requestId}.nack`, async (data) => {
    const nack = JSON.parse(data);
    log.info(`Download manager NACK request for ${request.gameId}:`, nack);
    // If nack.newRequestId is a string, try subscribing to it for process output
    // eslint-disable-next-line no-prototype-builtins
    const subscribeTo = nack.message.hasOwnProperty('subscribeTo') ? nack.message.subscribeTo : false;
    if (subscribeTo) {
      log.warn('Download appears to be in process, subscribing to output');
      // subscribe
      ipc.subscribe(`${subscribeTo}.progress`, (progress) => {
        progress = JSON.parse(progress);
        log.debug(progress);
      });

      ipc.subscribe(`${subscribeTo}.status`, (status) => {
        status = JSON.parse(status);
        log.info(`Download status update for ${request.gameId}: ${status.message}`);
        if (status.message === 'completed') {
          exit(moduleIdent, ipc, 0);
        }
      });
    } else {
      // If we don't get the channel, exit
      log.error('Received NACK but no in-progress channel, exiting');
      log.error(nack);
    }
  });

  ipc.subscribe(`${moduleIdent}.${request.requestId}.progress`, (data) => {
    const progress = JSON.parse(data);
    // log.debug(`Progress message:`, progress);
  });

  ipc.subscribe(`${moduleIdent}.${request.requestId}.output`, (data) => {
    const output = JSON.parse(data);
    // log.debug('Output message:', output);
  });

  ipc.subscribe(`${moduleIdent}.${request.requestId}.status`, (data) => {
    const status = JSON.parse(data);
    if (status.message === 'completed') {
      // Do something
      ipc.unsubscribe(`${moduleIdent}.${request.requestId}.ack`);
      ipc.unsubscribe(`${moduleIdent}.${request.requestId}.nack`);
      ipc.unsubscribe(`${moduleIdent}.${request.requestId}.error`);
      ipc.unsubscribe(`${moduleIdent}.${request.requestId}.progress`);
      ipc.unsubscribe(`${moduleIdent}.${request.requestId}.output`);
      ipc.unsubscribe(`${moduleIdent}.${request.requestId}.status`);
    }
  });
}
