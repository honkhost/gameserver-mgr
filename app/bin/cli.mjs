'use strict';

// Our libs
import { setupIpc } from '../lib/ipc.mjs';
import { setPidFile } from '../lib/pid.mjs';
import { lockFile } from '../lib/lockfile.mjs';
import { setupTerminationSignalHandlers } from '../lib/signals.mjs';
import { setPingReply } from '../lib/ping.mjs';

// External libs
import { default as clog } from 'ee-log';
import { default as yargs } from 'yargs';

const ident = 'cli';

const debug = process.env.DEBUG || false;

//
// Start boilerplate

// Create our lockfile
await lockFile(ident);

// Set our PID file
await setPidFile(ident);

// Setup our IPC "connection"
const ipc = await setupIpc();

// Setup our termination handlers for SIGTERM and SIGINT
setupTerminationSignalHandlers(ident, ipc);

setPingReply(ipc, ident, 'init')

//
// End boilerplate

if (debug > 3) {
  ipc.on('start', () => {
    clog.debug('IPC "connected"');
    // Print every message we receive if debug is enabled
    ipc.subscribe(`${ident}.#`, (data, info) => {
      clog.debug('Incoming IPC message: ', JSON.stringify(JSON.parse(data.toString()), null, 2), info);
    });
  });
}

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

function sendMessage(argv) {
  // no-op
}

function systemStatus(argv) {
  // no-op
}

function moduleStatus(argv) {
  // no-op
}
