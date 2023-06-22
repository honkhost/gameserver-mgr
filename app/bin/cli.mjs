'use strict';

// Our libs
import { setupIpc, setPingReply } from '../lib/ipc.mjs';
import { lockFile } from '../lib/lockfile.mjs';
import { handleTerminationSignal, exit } from '../lib/exitHandlers.mjs';
import { setupLog } from '../lib/log.mjs';
import { parseBool } from '../lib/parseBool.mjs';

// Node stdlib
import { default as crypto } from 'node:crypto';
import { default as path } from 'node:path';

// External libs
import { default as yargs } from 'yargs';
import { hideBin } from 'yargs/helpers';

const moduleIdent = 'cli';

//
// Start boilerplate

// Setup logger
const log = setupLog('bin/cli.mjs');

// Create our lockfile
await lockFile(moduleIdent);

// Setup our IPC "connection"
const ipc = await setupIpc(moduleIdent);

// Setup our termination handlers for SIGTERM and SIGINT
// Handle SIGINT
process.once('SIGINT', () => {
  handleTerminationSignal(moduleIdent, ipc, 'SIGINT');
});

// Handle SIGTERM
process.once('SIGTERM', () => {
  handleTerminationSignal(moduleIdent, ipc, 'SIGTERM');
});

// Set initial ping reply
setPingReply(moduleIdent, ipc, 'init');

// Debug modes
const debug = parseBool(process.env.DEBUG) || false;
const steamcmdDebug = parseBool(process.env.DEBUG_STEAMCMD) || false;
const ipcDebug = parseBool(process.env.DEBUG_IPC) || false;

if (ipcDebug) {
  ipc.subscribe('#', (data) => {
    const message = JSON.parse(data);
    log.debug(message);
  });
}

//
// End boilerplate

ipc.on('start', () => {
  setPingReply(moduleIdent, ipc, 'running');

  yargs(hideBin(process.argv))
    .command(
      'send <channel> <message>',
      'Send an IPC message',
      () => {},
      (argv) => {
        sendMessage(argv);
      },
    )
    .command(
      'downloadGame <game>',
      'Download a game from steam',
      (yargs) => {
        return yargs
          .positional('game', {
            type: 'string',
            describe: 'Game manifest to download',
            demand: true,
          })
          .option('force', {
            type: 'boolean',
            description: 'Forcefully interrupt in-progress downloads',
            demand: false,
          })
          .option('validate', {
            type: 'boolean',
            description: 'Force validation of gameserver files after download',
            demand: false,
            default: false,
          })
          .option('clean', {
            type: 'boolean',
            description: 'Request removal of gameserver files before download',
            demand: false,
            default: false,
          })
          .option('steamcmd-clean', {
            type: 'boolean',
            description: 'Request removal of steamcmd files before download',
            demand: false,
            default: false,
          })
          .option('username', {
            type: 'string',
            description: 'Username to login to steam with',
            demand: false,
            default: '',
          })
          .option('password', {
            type: 'string',
            description: 'Password to login to steam with',
            demand: false,
            default: '',
          })
          .option('root-directory', {
            type: 'string',
            description: 'Root directory for install',
            demand: false,
            default: '/opt/gsm',
          });
      },
      (argv) => {
        downloadGame(argv);
      },
    )
    .command(
      'listDownloads',
      'List running downloads',
      (yargs) => {
        return yargs;
      },
      (argv) => {
        listDownloads(argv);
      },
    )
    .command(
      'cancelDownload <game>',
      'Cancel a game download',
      (yargs) => {
        return yargs
          .positional('game', {
            type: 'string',
            describe: 'Game download to cancel',
            demand: true,
          })
          .option('cleanup', {
            type: 'boolean',
            describe: 'Remove incomplete download',
            demand: false,
          });
      },
      (argv) => {
        cancelDownload(argv);
      },
    )
    .demandCommand(1)
    .strict()
    .parse();
});

function initSystem(argv) {
  // no-op
}

function shutdownSystem(argv) {
  // no-op
}

function startModule(argv) {
  // no-op
}

function stopModule(argv) {
  // no-op
}

function restartModule(argv) {
  // no-op
}

/**
 * Send a message out on the IPC
 * @param {Object} argv - argv as parsed by `yargs.parse(process.argv)`
 */
function sendMessage(argv) {
  const requestId = crypto.randomUUID();
  const targetChannel = argv.channel;
  const msg = {
    requestId: requestId,
    timestamp: Date.now(),
    message: argv.message,
    replyTo: `${moduleIdent}.${requestId}`,
  };

  // Send out the message
  log.info('Sending message');
  ipc.publish(targetChannel, JSON.stringify(msg));

  // Wait for replies
  log.info('Waiting for replies');
  setTimeout(() => {
    exit(moduleIdent, ipc);
  }, 10000);

  ipc.subscribe(msg.replyTo, (data) => {
    log.info('Message reply:', JSON.stringify(JSON.parse(data.toString()), null, 2));
  });
}

/**
 * Download a game based on cli params
 * @param {Object} argv - argv as parsed by `yargs.parse(process.argv)`
 */
function downloadGame(argv) {
  if (debug) log.debug(argv);
  const gameId = argv.game || '';

  if (!gameId || gameId === '') {
    throw new Error('process.env.gameId required!');
  }
  const _serverFilesRootDir = argv['root-directory'] || `/opt/gsm/`;
  const serverFilesRootDir = path.resolve(_serverFilesRootDir);
  const serverFilesBaseDir = path.resolve(serverFilesRootDir, 'base', gameId);
  const steamCmdDir = path.resolve(serverFilesRootDir, 'steamcmd');

  const requestId = crypto.randomUUID();
  const request = {
    requestId: requestId,
    replyTo: `${moduleIdent}.${requestId}`,
    message: {
      gameId: gameId,
      downloadForce: argv['force'] || false,
      validate: argv['validate'] || false,
      steamCmdForce: argv['steamcmd-clean'] || false,
      steamCmdDir: steamCmdDir,
      downloadDir: serverFilesBaseDir,
      anonymous: argv['username'] ? false : true,
      username: argv['password'] || '',
      password: argv['password'] || '',
      serverFilesForce: argv['clean'] || false,
      steamcmdMultiFactorEnabled: false,
    },
  };

  log.info(`Sending request for ${request.message.gameId} to the download manager`);
  ipc.publish(`downloadManager.downloadUpdateGame`, JSON.stringify(request));

  ipc.subscribe(`${moduleIdent}.${request.requestId}.ack`, async (data) => {
    const ack = JSON.parse(data);
    if (debug) log.info(`Download manager ACK request for ${request.gameId}:`);
    // eslint-disable-next-line no-prototype-builtins
    const subscribeTo = ack.message.hasOwnProperty('subscribeTo') ? ack.message.subscribeTo : false;
    // Subscribe to the download progress channels
    // Error messages
    ipc.subscribe(`${subscribeTo}.error`, (error) => {
      error = JSON.parse(error.toString());
      log.error(`Error while downloading ${request.gameId}: ${error.message}`);
      if (error.message == 'SHUTDOWN') {
        exit(moduleIdent, ipc, 1);
      }
    });

    // Progress messages
    ipc.subscribe(`${subscribeTo}.progress`, (progress) => {
      progress = JSON.parse(progress);
      if (debug) log.debug(progress);

      // If debug is disabled, prettyprint the progress for cli display
      if (!debug && !steamcmdDebug) {
        var downloadStage = '';
        progress.message.downloadStage === 'steamcmd_download' ? (downloadStage = 'Updating Steamcmd') : null;
        progress.message.downloadStage === 'appid_download' ? (downloadStage = 'Updating Application') : null;
        const downloadState = progress.message.downloadState;
        const downloadProgress = progress.message.downloadProgress;
        const downloadRx = progress.message.downloadProgressReceived;
        const downloadTotal = progress.message.downloadProgressTotal;
        log.info(`${downloadStage} - ${downloadState} - ${downloadProgress}% [${downloadRx} / ${downloadTotal}]`);
      }
    });

    // Raw download output
    ipc.subscribe(`${subscribeTo}.output`, (output) => {
      output = JSON.parse(output);
      const logLine = JSON.parse(output.message);
      if (steamcmdDebug) log.debug(`[${logLine.timestamp}] ${logLine.line}`);
    });

    // Subscribe to finalStatus messages - download completed / failed / canceled / etc
    ipc.subscribe(`${subscribeTo}.finalStatus`, (status) => {
      status = JSON.parse(status);
      log.info(`Download status update for ${request.gameId}:`, status.message.status);
      if (status.message.status === 'completed') {
        exit(moduleIdent, ipc, 0);
      }
    });
  });

  ipc.subscribe(`${moduleIdent}.${request.requestId}.nack`, (nack) => {
    nack = JSON.parse(nack);

    // Friendly display of the reason for the nack
    var displayNack = '';
    nack instanceof Error ? (displayNack = nack.message) : (displayNack = nack.message.reason);

    // If nack.newRequestId is a string, try subscribing to it for process output
    // eslint-disable-next-line no-prototype-builtins
    const subscribeTo = nack.message.hasOwnProperty('subscribeTo') ? nack.message.subscribeTo : false;
    if (nack.message.alreadyRequested && subscribeTo) {
      log.warn(`Download appears to be in process, subscribing to output on ${subscribeTo}`);

      // Subscribe to the download progress channels
      // Error messages
      ipc.subscribe(`${subscribeTo}.error`, (error) => {
        error = JSON.parse(error.toString());
        log.error(`Error while downloading ${request.gameId}: ${error.message}`);
        if (error.message == 'SHUTDOWN') {
          exit(moduleIdent, ipc, 1);
        }
      });

      // Progress messages
      ipc.subscribe(`${subscribeTo}.progress`, (progress) => {
        progress = JSON.parse(progress);
        if (debug) log.debug(progress);

        // If debug is disabled, prettyprint the progress for cli display
        if (!debug && !steamcmdDebug) {
          var downloadStage = '';
          progress.message.downloadStage === 'steamcmd_download' ? (downloadStage = 'Updating Steamcmd') : null;
          progress.message.downloadStage === 'appid_download' ? (downloadStage = 'Updating Application') : null;
          const downloadState = progress.message.downloadState;
          const downloadProgress = progress.message.downloadProgress;
          const downloadRx = progress.message.downloadProgressReceived;
          const downloadTotal = progress.message.downloadProgressTotal;
          log.info(`${downloadStage} - ${downloadState} - ${downloadProgress}% [${downloadRx} / ${downloadTotal}]`);
        }
      });

      // Raw download output
      ipc.subscribe(`${subscribeTo}.output`, (output) => {
        output = JSON.parse(output);
        const logLine = JSON.parse(output.message);
        if (steamcmdDebug) log.debug(`[${logLine.timestamp}] ${logLine.line}`);
      });

      // Subscribe to finalStatus messages - download completed / failed / canceled / etc
      ipc.subscribe(`${subscribeTo}.finalStatus`, (status) => {
        status = JSON.parse(status);
        log.info(`Download status update for ${request.gameId}:`, status.message);
        if (status.message.reason === 'completed') {
          exit(moduleIdent, ipc, 0);
        }
      });
    } else if (nack.message.alreadyMounted) {
      log.error(`Download manager NACK request for ${request.gameId}: ${displayNack}`);
      exit(moduleIdent, ipc, 6);
    } else {
      // If we don't get the channel, exit
      log.error('Received NACK for unknown reason, exiting');
      log.error(nack);
      exit(moduleIdent, ipc, 3);
    }
  });
}

/**
 * Cancel a game download
 */
function cancelDownload(argv) {
  // First we need to list running downloads
  const downloadListRequestRequestId = crypto.randomUUID();
  const downloadListRequest = {
    requestId: downloadListRequestRequestId,
    replyTo: `${moduleIdent}.${downloadListRequestRequestId}`,
    timestamp: Date.now(),
  };

  ipc.subscribe(downloadListRequest.replyTo, (reply) => {
    reply = JSON.parse(reply);
    const list = reply.message;
    if (list.length === 0) {
      log.info('No downloads in progress (at all)');
      return;
    }

    Object.keys(list).forEach((key) => {
      // eslint-disable-next-line security/detect-object-injection
      const listItem = list[key];
      if (debug) log.debug(listItem);

      log.info(`Download in progress: ${listItem.gameId} ${listItem.progressSnapshot.downloadProgress}%`);

      if (key === argv['game']) {
        const requestIdToCancel = listItem.request.message.requestId;
        const gameIdToCancel = listItem.request.message.gameId;

        const downloadCancelRequestRequestId = crypto.randomUUID();
        const downloadCancelRequest = {
          requestId: downloadCancelRequestRequestId,
          replyTo: `${moduleIdent}.${downloadCancelRequestRequestId}`,
          timestamp: Date.now(),
          message: {
            requestIdToCancel: requestIdToCancel,
            gameIdToCancel: gameIdToCancel,
            command: 'cancel',
            cleanup: argv['cleanup'] || false,
          },
        };
        ipc.subscribe(`${listItem.request.replyTo}.finalStatus`, (reply) => {
          reply = JSON.parse(reply);
          if (debug) log.debug('cancelDownload request reply', reply);
          if (reply.message.status === 'canceled') {
            log.info(`Download request for ${argv['game']} canceled successfully`);
            exit(moduleIdent, ipc, 0);
          }
        });

        log.info(`Sending download cancel request for ${argv['game']}`);
        if (debug) log.debug(`sending req to ${reply.moduleIdent}.cancelDownload`);
        ipc.publish(`${reply.moduleIdent}.cancelDownload`, JSON.stringify(downloadCancelRequest));
      }
    });
  });
  ipc.publish('downloadManager.listRunningDownloads', JSON.stringify(downloadListRequest));
}

/**
 * Ask downloadmanager for a list of running downloads
 */
function listDownloads(argv) {
  const requestId = crypto.randomUUID();
  const request = {
    requestId: requestId,
    replyTo: `${moduleIdent}.${requestId}`,
    timestamp: Date.now(),
  };

  ipc.subscribe(request.replyTo, (list) => {
    list = JSON.parse(list);
    log.info(JSON.stringify(list, null, 2));
    exit(moduleIdent, ipc, 0);
  });

  ipc.publish('downloadManager.listRunningDownloads', JSON.stringify(request));
}

function systemStatus(argv) {
  // no-op
}

function moduleStatus(argv) {
  // no-op
}
