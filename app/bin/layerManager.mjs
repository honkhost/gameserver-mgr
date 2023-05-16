'use strict';

// Layer manager
// Sets up and tears down overlayfs mounts

// Our libs
import { setupIpc, setPingReply, sendRequestReply } from '../lib/ipc.mjs';
import { releaseLock, spinLock, spinClear } from '../lib/lock.mjs';
import { setupTerminationSignalHandlers } from '../lib/exitHandlers.mjs';
import { setupLog, isoTimestamp } from '../lib/log.mjs';
import { getDirName } from '../lib/dirname.mjs';
import { parseBool } from '../lib/parseBool.mjs';

// Nodejs stdlib
import { default as path } from 'node:path';
import { default as crypto } from 'node:crypto';
import { default as Stream } from 'node:stream';

//
// Start boilerplate
// Debug modes
const debug = parseBool(process.env.DEBUG) || false;

// Module id
const moduleIdent = 'layermanager';

// Populate __dirname
const __dirname = getDirName();

// Setup logger
const log = setupLog('bin/layermanager.mjs');

// Flag start-of-log
log.info('honk.host gameserver repo manager v0.4.20');
log.info(`--- Logs begin at ${isoTimestamp()} ---`);

// Create our lockfile (throws if it fails)
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

// Keep track of in-progress downloads
const mountedInstances = {};

//
// Start logic

// Tell everyone we're alive
ipc.on('start', () => {
  setPingReply(moduleIdent, ipc, 'ready');
});

// Listen for setupMount commands
