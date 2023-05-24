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
const log = setupLog('bin/downloadManager.mjs');

log.info('honk.host gameserver manager v0.4.20');
log.info(`--- Logs begin at ${isoTimestamp()} ---`);

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
          });
      },
      (argv) => {
        downloadGame(argv);
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
  const msgId = crypto.randomUUID();
  const targetChannel = argv.channel;
  const msg = {
    msgId: msgId,
    timestamp: Date.now(),
    msg: argv.message,
    replyTo: `${moduleIdent}.${msgId}`,
  };

  // Send out the message
  log.debug('Sending message');
  ipc.publish(targetChannel, JSON.stringify(msg));

  // Wait for replies
  log.debug('Waiting for replies');
  setTimeout(() => {
    exit(moduleIdent, ipc);
  }, 1000);

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
    serverFilesForce: argv.serverFilesForce || false,
  };

  log.info(`Sending request for ${request.gameId} to the download manager`);
  ipc.publish(`downloadManager.downloadUpdateGame`, JSON.stringify(request));

  ipc.subscribe(`${moduleIdent}.${request.requestId}.ack`, (ack) => {
    log.info(`Download manager ACK request for ${request.gameId}: ${ack}`);
  });

  ipc.subscribe(`${moduleIdent}.${request.requestId}.nack`, (nack) => {
    nack = JSON.parse(nack.toString());
    log.warn(`Download manager NACK request for ${request.gameId}: ${JSON.stringify(nack, null, 2)}`);

    // If nack.message is a string, try subscribing to it for process output
    if (nack.message != '') {
      log.warn('Download appears to be in process, subscribing to output');
      ipc.subscribe(`${moduleIdent}.${nack.message}.progress`, (progress) => {
        progress = JSON.parse(progress);
        log.debug(progress.message);
      });
      ipc.subscribe(`${moduleIdent}.${nack.message}.status`, (status) => {
        status = JSON.parse(status);
        log.info(`Download status update for ${request.gameId}: ${status.message}`);
        if (status.message === 'completed') {
          exit(moduleIdent, ipc, 0);
        }
      });
    } else {
      exit(moduleIdent, ipc, 1);
    }
  });

  ipc.subscribe(`${moduleIdent}.${request.requestId}.error`, (error) => {
    error = JSON.parse(error.toString());
    log.error(`Error while downloading ${request.gameId}: ${JSON.stringify(error, null, 2)}`);
  });

  ipc.subscribe(`${moduleIdent}.${request.requestId}.progress`, (progress) => {
    progress = JSON.parse(progress);
    log.debug(progress.message);
  });

  ipc.subscribe(`${moduleIdent}.${request.requestId}.status`, (status) => {
    status = JSON.parse(status);
    log.info(`Download status update for ${request.gameId}: ${status.message}`);
    if (status.message === 'completed') {
      exit(moduleIdent, ipc, 0);
    }
  });
}

function systemStatus(argv) {
  // no-op
}

function moduleStatus(argv) {
  // no-op
}
