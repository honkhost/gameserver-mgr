'use strict';

// Our libs
import { releaseLock } from './lock.mjs';
import { setupLog } from './log.mjs';

// External libs
// We import qlobber-fsq here so we can use it as a datatype in the function sig below
import { default as qfsq } from 'qlobber-fsq';

const log = setupLog('lib/exitHandlers.mjs');

/**
 * Setup SIGINT and SIGTERM handlers
 * @param {String} moduleIdent - the module's ident
 * @param {qfsq.QlobberFSQ} ipc - the module's ipc object
 * @returns {void}
 */
export function setupTerminationSignalHandlers(moduleIdent = '', ipc = qfsq.QlobberFSQ) {
  log.debug(`Setting up exit signal handlers...`);

  // Handle SIGINT
  process.once('SIGINT', () => {
    handleTerminationSignal(moduleIdent, ipc, 'SIGINT');
  });

  // Handle SIGTERM
  process.once('SIGTERM', () => {
    handleTerminationSignal(moduleIdent, ipc, 'SIGTERM');
  });

  // Handle ipc shutdown commands
  ipc.subscribe(`_broadcast.shutdownAll`, (data) => {
    log.info(`Received shutdown command via ipc, cleaning up...`);

    // Reply to the command
    data = JSON.parse(data);
    const msg = {
      msgId: data.msgId,
      moduleIdent: moduleIdent,
      timestamp: Date.now(),
      msg: 'confirmed',
    };
    ipc.publish(data.replyTo, JSON.stringify(msg));

    // Terminate program
    exit(moduleIdent, ipc, 0);
  });
}

/**
 * Handler function for SIGTERM and SIGINT
 * @param {String} moduleIdent - the module's ident
 * @param {qfsq.QlobberFSQ} ipc - the module's ipc object
 * @param {String} signal - the exit signal we're using
 * @returns {void}
 */
export function handleTerminationSignal(moduleIdent = '', ipc = qfsq.QlobberFSQ, signal = 'SIGTERM') {
  process.stdout.write('\n');
  log.info(`Received ${signal}, cleaning up... (repeat to force)`);

  if (signal != 'SIGTERM' && signal != 'SIGINT') throw new Error('Only SIGTERM and SIGINT are supported');

  // Setup listener to force exit if they repeat SIGINT
  process.once(`${signal}`, () => {
    throw new Error(`Caught ${signal} twice, forcing exit.`);
  });

  // Exit
  exit(moduleIdent, ipc, 0);
}

/**
 * Generic exit helper \
 * Tears down ipc listeners
 * @param {String} moduleIdent - the module's ident
 * @param {qfsq.QlobberFSQ} ipc - the module's ipc object
 * @param {number} code - the exit code to return
 * @returns {void}
 */
export function exit(moduleIdent = '', ipc = qfsq.QlobberFSQ, code = 0) {
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

  // Set exitcode
  code ? (process.exitCode = code) : (process.exitCode = 0);

  // Set next tick to remove lockfile and exit
  process.nextTick(() => {
    releaseLock(moduleIdent);
  });
}
