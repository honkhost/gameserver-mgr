'use strict';

import { steamCmdDownloadSelf } from '../app/lib/steamcmd.mjs';

import { default as path } from 'node:path';
import { default as Stream } from 'node:stream';

const _serverFilesDir = process.env.SERVER_FILES_DIR || '/opt/serverfiles';
const serverFilesDir = path.resolve(path.normalize(_serverFilesDir));

const _steamCmdDir = process.env.STEAMCMD_DIR || '/opt/steamcmd';
const steamCmdDir = path.resolve(path.normalize(_steamCmdDir));

const outputSink = new Stream.PassThrough();

outputSink.on('data', (chunk) => {
  process.stdout.write(chunk.toString());
});

await steamCmdDownloadSelf({
  force: true,
  steamCmdDir: steamCmdDir,
  outputSink: outputSink,
});
