'use strict';

// Global Coordinator

// Our libs
import { setupIpc, setPingReply } from '../lib/ipc.mjs';
import { acquireLock, releaseLock, spinLock, spinClear } from '../lib/lock.mjs';
import { setupTerminationSignalHandlers, exit } from '../lib/exitHandlers.mjs';
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
const moduleIdent = 'lifecycleManager';

// Populate __dirname
const __dirname = getDirName();

// Setup logger
const log = setupLog('bin/lifecycleManager.mjs');

// Flag start-of-log
log.info('honk.host gameserver lifecycle manager v0.4.20');
log.info(`--- Logs begin at ${isoTimestamp()} ---`);

// Create our lockfile (throws if it fails)
// Unlocking handled within exit() calls
await spinLock(moduleIdent, 30);

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

// Pull gameID and instanceId from ennvvars
const gameId = process.env.GAME_ID || false;
const instanceId = process.env.INSTANCE_ID || false;
const _serverFilesRootDir = process.env.SERVER_FILES_ROOT_DIR || false;

// Validate that those three vars were provided
if (!gameId || gameId === '') {
  throw new Error('process.env.GAME_ID required!');
}
if (!instanceId || instanceId === '') {
  throw new Error('process.env.INSTANCE_ID required!');
}
if (!_serverFilesRootDir || _serverFilesRootDir === '') {
  throw new Error('process.env.SERVER_FILES_ROOT_DIR required!');
}

// Server files directories
const serverFilesRootDir = path.resolve(_serverFilesRootDir);
const serverFilesBaseDir = path.resolve(serverFilesRootDir, 'base', gameId);
const serverFilesConfigDir = path.resolve(serverFilesRootDir, 'config', gameId, instanceId);
const steamCmdDir = path.resolve(serverFilesRootDir, 'steamcmd');

// Do we force remove old files before downloading them?
const steamcmdFilesForce = parseBool(process.env.STEAMCMD_FILES_FORCE) || false;
const serverFilesForce = parseBool(process.env.SERVER_FILES_FORCE) || false;

// Steamcmd auth
const steamcmdAnonymous = parseBool(process.env.STEAMCMD_LOGIN_ANON) || true;
const steamcmdUsername = process.env.STEAMCMD_LOGIN_USERNAME || false;
const steamcmdPassword = process.env.STEAMCMD_LOGIN_PASSWORD || false;
const steamcmdMultiFactorEnabled = parseBool(process.env.STEAMCMD_TWOFACTOR_ENABLED) || false;

// Force validate downloads?
const steamcmdForceValidate = parseBool(process.env.STEAMCMD_INITIAL_DOWNLOAD_VALIDATE) || false;

// Git repo to download from
// Default: honk.host
const serverConfigRepo = process.env.SERVER_CONFIG_REPO || false;
// Force remove config and re-clone?
// Default: do 'git pull' on the config dir
const serverConfigFilesForce = parseBool(process.env.SERVER_CONFIG_FILES_FORCE) || false;
// SSH key to use
const serverConfigRepoSshKey = process.env.SERVER_CONFIG_SSH_KEY || false;

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

  // Acquire a lock for our instance
  try {
    await spinLock(`lifecycleManager-${gameId}-${instanceId}`);
  } catch (error) {
    if (error.code == 'EEXIST') {
      log.error('Could not acquire lifecycleLock', error);
      exit(moduleIdent, ipc, 1);
    }
  }

  // Wait for downloadManager to be available
  // We give it extra time as this is our initial startup
  try {
    await waitModuleRunning('downloadManager', { timeout: 60 });
  } catch (error) {
    log.error('Timeout waiting for downloadManager, exiting...');
    await releaseLock(`lifecycleManager-${gameId}-${instanceId}`);
    exit(moduleIdent, ipc, 2);
  }
  // Ask downloadManager to download our base game
  try {
    // Build the download request
    const downloadUpdateGameOptions = {
      // TODO: implement timeouts inside downloadUpdateGame
      timeout: 30, // between status updates
      gameId: gameId,
      instanceId: instanceId,
      validate: steamcmdForceValidate,
      steamCmdForce: steamcmdFilesForce,
      serverFilesForce: serverFilesForce,
      anonymous: steamcmdAnonymous,
      username: steamcmdUsername,
      password: steamcmdPassword,
      steamCmdDir: steamCmdDir,
      downloadDir: serverFilesBaseDir,
      steamcmdMultiFactorEnabled: steamcmdMultiFactorEnabled,
    };
    // Request the download, wait for it to finish or error
    const downloadResult = await downloadUpdateGame(downloadUpdateGameOptions);
    // if it failed out, throw
    // TODO: retry gracefully
    if (downloadResult.status != 'completed') {
      log.error(`Unable to download game ${gameId}`, downloadResult);
      await releaseLock(`lifecycleManager-${gameId}-${instanceId}`);
      exit(moduleIdent, ipc, 3);
    } else {
      // if it succeeded, continue
      if (debug) log.debug('downloadResult:', downloadResult);
    }
  } catch (error) {
    // Throw any unknown errors
    log.error(`Error downloading ${gameId}`, error);
    await releaseLock(`lifecycleManager-${gameId}-${instanceId}`);
    exit(moduleIdent, ipc, 2);
  }

  // Verify configManager is ready
  // It should be by now, so we stick with default 30s timeout
  try {
    await waitModuleRunning('configManager');
  } catch (error) {
    log.error('Timeout waiting for configManager, exiting...');
    await releaseLock(`lifecycleManager-${gameId}-${instanceId}`);
    exit(moduleIdent, ipc, 2);
  }

  // Ask it to download configs from git
  try {
    // Options to pass downloadUpdateServerConfigGitOptions below
    const downloadUpdateServerConfigGitOptions = {
      timeout: 30,
      instanceId: instanceId,
      repoUrl: serverConfigRepo,
      privKey: serverConfigRepoSshKey,
      serverConfigDir: serverFilesConfigDir,
      serverConfigFilesForce: serverConfigFilesForce,
    };
    const gitUpdateResult = await downloadUpdateServerConfigGit(downloadUpdateServerConfigGitOptions);
    if (gitUpdateResult.message.status != 'completed') {
      log.error('Unable to download server configuration from git', gitUpdateResult);
      await releaseLock(`lifecycleManager-${gameId}-${instanceId}`);
      exit(moduleIdent, ipc, 4);
    } else {
      if (debug) log.debug('gitUpdateResult', gitUpdateResult);
    }
    // Do something, continue
  } catch (error) {
    log.error(error);
    await releaseLock(`lifecycleManager-${gameId}-${instanceId}`);
    exit(moduleIdent, ipc, 2);
  }

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
function waitModuleRunning(target, options = { timeout: 30 }) {
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
      ipc.publish(`${target}.ping`, JSON.stringify(pingRequest));
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
    instanceId: instanceId,
    gameId: '',
    validate: false,
    steamCmdForce: false,
    serverFilesForce: false,
    steamCmdDir: '',
    downloadDir: '',
    anonymous: true,
    username: '',
    password: '',
    steamcmdMultiFactorEnabled: steamcmdMultiFactorEnabled,
  },
) {
  return new Promise((resolve, reject) => {
    // Send download request
    const requestId = crypto.randomUUID();
    const request = {
      requestId: requestId,
      replyTo: `${moduleIdent}.${requestId}`,
      gameId: options.gameId,
      validate: options.validate,
      steamCmdForce: options.steamCmdForce,
      steamCmdDir: options.steamCmdDir,
      serverFilesForce: options.serverFilesForce,
      downloadDir: options.downloadDir,
      anonymous: options.anonymous,
      username: options.username,
      password: options.password,
      steamcmdMultiFactorEnabled: options.steamcmdMultiFactorEnabled,
    };

    log.info(`Sending request for ${request.gameId} to the download manager`);
    ipc.publish(`downloadManager.downloadUpdateGame`, JSON.stringify(request));

    ipc.subscribe(`${moduleIdent}.${request.requestId}.ack`, async (data) => {
      const ack = JSON.parse(data);
      log.info(`Download manager ACK request for ${request.gameId}:`, ack);
      // eslint-disable-next-line no-prototype-builtins
      const subscribeTo = ack.hasOwnProperty('subscribeTo') ? ack.subscribeTo : false;
      try {
        const result = await waitTaskComplete(subscribeTo);
        return resolve(result);
      } catch (error) {
        log.error(error);
        return reject(error);
      }
    });

    ipc.subscribe(`${moduleIdent}.${request.requestId}.nack`, async (data) => {
      const nack = JSON.parse(data);
      log.info(`Download manager NACK request for ${request.gameId}:`, nack);
      // If nack.newRequestId is a string, try subscribing to it for process output
      // eslint-disable-next-line no-prototype-builtins
      const subscribeTo = nack.hasOwnProperty('subscribeTo') ? nack.subscribeTo : false;
      if (subscribeTo) {
        try {
          const result = await waitTaskComplete(subscribeTo);
          return resolve(result);
        } catch (error) {
          log.error(error);
          return reject(error);
        }
      }
    });
  });
}

function downloadUpdateServerConfigGit(
  options = {
    timeout: 30,
    instanceId: '',
    repoUrl: '',
    privKey: '',
    serverConfigDir: '',
    serverConfigFilesForce: '',
  },
) {
  return new Promise((resolve, reject) => {
    return reject(new Error('not yet implemented!'));
  });
}

function waitTaskComplete(channel) {
  return new Promise((resolve, reject) => {
    ipc.subscribe(`${channel}.error`, (response) => {
      response = JSON.parse(response);
      log.error('Error while downloading:', response);
      return reject(new Error(response));
    });

    ipc.subscribe(`${channel}.progress`, (data) => {
      const progress = JSON.parse(data);
      // if (debug) log.debug`Progress message:`, progress);
    });

    ipc.subscribe(`${channel}.output`, (data) => {
      const output = JSON.parse(data);
      if (debug) log.debug('Output message:', output);
    });

    ipc.subscribe(`${channel}.finalStatus`, (data) => {
      const finalStatus = JSON.parse(data);
      if (debug) log.debug('finalStatus:', finalStatus);

      ipc.unsubscribe(`${channel}.ack`);
      ipc.unsubscribe(`${channel}.nack`);
      ipc.unsubscribe(`${channel}.error`);
      ipc.unsubscribe(`${channel}.progress`);
      ipc.unsubscribe(`${channel}.output`);
      ipc.unsubscribe(`${channel}.status`);
      ipc.unsubscribe(`${channel}.finalStatus`);
      if (finalStatus.reason === 'completed') {
        // Do something
        return resolve(finalStatus);
      } else {
        return reject(finalStatus);
      }
    });
  });
}
