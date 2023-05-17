'use strict';

// Our libs
import { timestamp } from './timestamp.mjs';
import { unlockFile } from './lockfile.mjs';

// External libs
// We import qlobber-fsq here so we can use it as a datatype in the function sig below
import { default as qfsq } from 'qlobber-fsq';

export function setupTerminationSignalHandlers(ident = '', ipc = qfsq.QlobberFSQ) {
  console.log(`[${timestamp()}] Setting up signal handlers...`);

  // Handle SIGINT
  process.once('SIGINT', () => {
    handleTerminationSignal(ident, ipc, 'SIGINT');
  });

  // Handle SIGTERM
  process.once('SIGTERM', () => {
    handleTerminationSignal(ident, ipc, 'SIGTERM');
  });
}

export function handleTerminationSignal(ident = '', ipc = qfsq.QlobberFSQ, signal = 'UNKNOWN SIGNAL') {
  console.log(`[${timestamp()}] Received ${signal}, cleaning up... (repeat to force)`);

  // Setup listener to force exit if they repeat SIGINT
  process.once(`${signal}`, () => {
    throw new Error(`Caught ${signal} twice, forcing exit.`);
  });

  // Set a timeout to force exit anyway
  setTimeout(() => {
    throw new Error('Timeout expired, forcing exit.');
  }, 5000).unref();

  // Unsubscribe from all IPC channels/events
  ipc.unsubscribe();
  ipc.stop_watching();
  ipc.removeAllListeners();

  // Set next tick to remove lockfile and exit
  process.nextTick(() => {
    unlockFile(ident);
    process.exitCode = 0;
  });
}

// Generic exit helper
export function exit(ident = '', ipc = qfsq.QlobberFSQ, code = 0) {
  // Set a timeout to force exit anyway
  setTimeout(() => {
    throw new Error('Timeout expired, forcing exit.');
  }, 5000).unref();

  // Unsubscribe from all IPC channels/events
  ipc.unsubscribe();
  ipc.stop_watching();
  ipc.removeAllListeners();

  // Remove other listeners that might keep us alive
  process.removeAllListeners();

  // Remove lockfile
  unlockFile(ident);

  // Set exitcode
  code ? (process.exitCode = code) : (process.exitCode = 0);
}
