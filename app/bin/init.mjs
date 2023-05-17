'use strict';

// Our libraries
import { timestamp } from '../lib/timestamp.mjs';
import { parseBool } from '../lib/parseBool.mjs';

// Nodejs stdlib
import { default as path } from 'node:path';
import { default as Stream } from 'node:stream';

// External libs
import { default as elog } from 'ee-log';

// Loud but useful
const debug = parseBool(process.env.DEBUG) || true;

// Very important
const logo = ` _                 _      _               _   
| |               | |    | |             | |  
| |__   ___  _ __ | | __ | |__   ___  ___| |_ 
| '_ \\ / _ \\| '_ \\| |/ / | '_ \\ / _ \\/ __| __|
| | | | (_) | | | |   < _| | | | (_) \\__ \\ |_ 
|_| |_|\\___/|_| |_|_|\\_(_)_| |_|\\___/|___/\\__|`;

console.log(`[${timestamp()}] --- Logs begin at ${timestamp()} ---`);
console.log(`[${timestamp()}] honk.host gameserver manager v0.4.20`);
console.log(logo);

// Config
const _serverFilesDir = process.env.SERVER_FILES_DIR || '/opt/serverfiles';
const serverFilesDir = path.resolve(path.normalize(_serverFilesDir));

const _steamCmdDir = process.env.STEAMCMD_DIR || '/opt/steamcmd';
const steamCmdDir = path.resolve(path.normalize(_steamCmdDir));

// Determine game type

// Determine download type

// Load up other config

// Check if game installed

// Download game

// Check for update
