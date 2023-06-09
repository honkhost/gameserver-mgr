'use strict';

// Our libs
import { setupIpc, setPingReply } from '../lib/ipc.mjs';
import { lockFile } from '../lib/lockfile.mjs';
import { handleTerminationSignal, exit } from '../lib/exitHandlers.mjs';
import { setupLog, isoTimestamp } from '../lib/log.mjs';

// Node stdlib
import { default as crypto } from 'node:crypto';

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
          .option('force', {
            type: 'boolean',
            description: 'Force removal of gameserver files before download',
          })
          .positional('game', {
            type: 'string',
            describe: 'Game manifest to download',
            demand: true,
          })
          .option('username', {
            type: 'string',
            description: 'Username to login to steam with',
            demand: false,
          })
          .option('password', {
            type: 'string',
            description: 'Password to login to steam with',
            demand: false,
          })
          .option('download-directory', {
            type: 'string',
            description: 'Directory to download server files to',
            demand: false,
          })
          .option('steamcmd-directory', {
            type: 'string',
            description: 'Directory for steamcmd',
            demand: false,
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
        return yargs.positional('game', {
          type: 'string',
          describe: 'Game download to cancel',
          demand: true,
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
  log.debug('Sending message');
  ipc.publish(targetChannel, JSON.stringify(msg));

  // Wait for replies
  log.debug('Waiting for replies');
  setTimeout(() => {
    exit(moduleIdent, ipc);
  }, 10000);

  ipc.subscribe(msg.replyTo, (data) => {
    log.debug('Message reply:', JSON.stringify(JSON.parse(data.toString()), null, 2));
  });
}

/**
 * Download a game based on cli params
 * @param {Object} argv - argv as parsed by `yargs.parse(process.argv)`
 */
function downloadGame(argv) {
  const requestId = crypto.randomUUID();
  const request = {
    requestId: requestId,
    replyTo: `${moduleIdent}.${requestId}`,
    gameId: argv.game || 'csgo',
    validate: false,
    steamCmdForce: false,
    steamCmdDir: '/opt/gsm/steamcmd',
    serverFilesDir: argv['download-directory'] || '/opt/gsm/csgo',
    anonymous: argv.username ? false : true,
    username: argv.username || undefined,
    password: argv.password || undefined,
    serverFilesForce: argv.force || false,
  };

  log.info(`Sending request for ${request.gameId} to the download manager`);
  ipc.publish(`downloadManager.downloadUpdateGame`, JSON.stringify(request));

  ipc.subscribe(`${request.replyTo}.ack`, (ack) => {
    log.info(`Download manager ACK request for ${request.gameId}: ${ack}`);
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
        // log.debug(progress.message.progressLine);
      });

      ipc.subscribe(`${subscribeTo}.output`, (output) => {
        output = JSON.parse(output);
        log.debug(output);
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

  ipc.subscribe(`${request.replyTo}.error`, (error) => {
    error = JSON.parse(error.toString());
    log.error(`Error while downloading ${request.gameId}: ${error.message}`);
    if (error.message == 'SHUTDOWN') {
      exit(moduleIdent, ipc, 1);
    }
  });

  ipc.subscribe(`${request.replyTo}.progress`, (progress) => {
    progress = JSON.parse(progress);
    // log.debug(progress.message.progressLine);
  });

  ipc.subscribe(`${request.replyTo}.output`, (output) => {
    output = JSON.parse(output);
    log.debug(output);
  });

  ipc.subscribe(`${request.replyTo}.status`, (status) => {
    status = JSON.parse(status);
    log.info(`Download status update for ${request.gameId}: ${status.message}`);
    if (status.message === 'completed') {
      exit(moduleIdent, ipc, 0);
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

    Object.keys(list).forEach((key) => {
      // eslint-disable-next-line security/detect-object-injection
      const listItem = list[key];
      log.debug(listItem);

      if (key === argv.game) {
        const requestIdToCancel = listItem.request.requestId;

        const downloadCancelRequestRequestId = crypto.randomUUID();
        const downloadCancelRequest = {
          requestId: downloadCancelRequestRequestId,
          replyTo: `${moduleIdent}.${downloadCancelRequestRequestId}`,
          timestamp: Date.now(),
          message: {
            command: 'cancel',
          },
        };
        ipc.subscribe(`${downloadCancelRequest.replyTo}.status`, (reply) => {
          reply = JSON.parse(reply);
          if (reply.message === 'canceled') {
            log.info(`Download request for ${argv.game} canceled`);
            exit(moduleIdent, ipc, 0);
          }
        });

        log.debug(`sending req to ${reply.moduleIdent}.${requestIdToCancel}.cancelDownload`);
        ipc.publish(`${reply.moduleIdent}.${requestIdToCancel}.cancelDownload`, JSON.stringify(downloadCancelRequest));
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
