'use strict';

import { steamCmdDownloadAppid } from '../app/lib/steamcmd.mjs';

import { default as path } from 'node:path';

const _serverFilesDir = process.env.SERVER_FILES_DIR || '/opt/serverfiles';
const serverFilesDir = path.normalize(_serverFilesDir);

const _steamCmdDir = process.env.STEAMCMD_DIR || '/opt/steamcmd';
const steamCmdDir = path.normalize(_steamCmdDir);

await steamCmdDownloadAppid({
  appid: 740,
  serverFilesDir: serverFilesDir,
  steamCmdDir: steamCmdDir,
});
