'use strict';

// Our libraries
import { setupIpc } from '../app/lib/ipc.mjs';
import { setupLog } from '../app/lib/log.mjs';

// Node stdlib
import { default as path } from 'node:path';
import { default as crypto } from 'node:crypto';

const _serverFilesDir = process.env.SERVER_FILES_DIR || '/opt/serverfiles';
const serverFilesDir = path.resolve(path.normalize(_serverFilesDir));

const _steamCmdDir = process.env.STEAMCMD_DIR || '/opt/steamcmd';
const steamCmdDir = path.resolve(path.normalize(_steamCmdDir));

const log = setupLog('dev-scripts/download-csgo-test.mjs');

const moduleIdent = 'testscript';

// Setup our IPC "connection"
const ipc = await setupIpc(moduleIdent);

// await steamCmdDownloadAppid({
//   appid: 740,
//   serverFilesDir: serverFilesDir,
//   steamCmdDir: steamCmdDir,
//   validate: false,
// });

ipc.on('start', () => {
  const requestId = crypto.randomUUID();

  const request = {
    requestId: requestId,
    replyTo: `${moduleIdent}.${requestId}`,
    gameId: 'csgo',
    validate: false,
    steamCmdForce: false,
    steamCmdDir: '/opt/gsm/steamcmd',
    serverFilesForce: false,
    serverFilesDir: '/opt/gsm/csgo',
    anonymous: true,
  };
  log.info(`Sending request for ${request.gameId} to the download manager`);
  ipc.publish(`downloadManager.downloadUpdateGame`, JSON.stringify(request));

  ipc.subscribe(`${moduleIdent}.${requestId}.ack`, (response) => {
    log.info(`Download manager ACK request for ${request.gameId}: response`);
  });

  ipc.subscribe(`${moduleIdent}.${requestId}.nack`, (response) => {
    log.error(`Download manager NACK request for ${request.gameId}: response`);
  });

  ipc.subscribe(`${moduleIdent}.${requestId}.error`, (response) => {
    response = JSON.parse(response.toString());
    log.error(`Error while downloading ${request.gameId}: ${JSON.stringify(response, null, 2)}`);
  });

  ipc.subscribe(`${moduleIdent}.${requestId}.progress`, (progress) => {
    progress = JSON.parse(progress);
    log.debug(progress.message);
  });

  ipc.subscribe(`${moduleIdent}.${requestId}.status`, (status) => {
    status = JSON.parse(status);
    log.info(`Download status update for ${request.gameId}: ${status.message}`);
  });
});
