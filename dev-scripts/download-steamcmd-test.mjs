'use strict';

import { steamCmdDownloadSelf } from '../app/lib/steamcmd.mjs';

import { default as path } from 'node:path';

const _serverFilesDir = process.env.SERVER_FILES_DIR || '/opt/serverfiles';
const serverFilesDir = path.resolve(path.normalize(_serverFilesDir));

const _steamCmdDir = process.env.STEAMCMD_DIR || '/opt/steamcmd';
const steamCmdDir = path.resolve(path.normalize(_steamCmdDir));

await steamCmdDownloadSelf({
  force: true,
  steamCmdDir: steamCmdDir,
});
