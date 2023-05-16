'use strict';

// Our libraries
import { setupIpc, setPingReply } from '../lib/ipc.mjs';
import { lockFile } from '../lib/lockfile.mjs';
import { setupTerminationSignalHandlers } from '../lib/exitHandlers.mjs';
import { setupLog, isoTimestamp } from '../lib/log.mjs';

const moduleIdent = 'init';

// Very important

const logo = `
  ██╗░░██╗░█████╗░███╗░░██╗██╗░░██╗░░░██╗░░██╗░█████╗░░██████╗████████╗
  ██║░░██║██╔══██╗████╗░██║██║░██╔╝░░░██║░░██║██╔══██╗██╔════╝╚══██╔══╝
  ███████║██║░░██║██╔██╗██║█████═╝░░░░███████║██║░░██║╚█████╗░░░░██║░░░
  ██╔══██║██║░░██║██║╚████║██╔═██╗░░░░██╔══██║██║░░██║░╚═══██╗░░░██║░░░
  ██║░░██║╚█████╔╝██║░╚███║██║░╚██╗██╗██║░░██║╚█████╔╝██████╔╝░░░██║░░░
  ╚═╝░░╚═╝░╚════╝░╚═╝░░╚══╝╚═╝░░╚═╝╚═╝╚═╝░░╚═╝░╚════╝░╚═════╝░░░░╚═╝░░░
`;

console.log(logo);

//
// Start boilerplate

// Setup logger
const log = setupLog('bin/init.mjs');

log.info('honk.host gameserver manager v0.4.20');
log.info(`--- Logs begin at ${isoTimestamp()} ---`);

// Create our lockfile
await acquireLock(moduleIdent);

// Setup our IPC "connection"
const ipc = await setupIpc(moduleIdent);

// Setup our termination handlers for SIGTERM and SIGINT
setupTerminationSignalHandlers(moduleIdent, ipc);

// Set initial ping reply
setPingReply(moduleIdent, ipc, 'init');

//
// End boilerplate

// Config

//
// End config

//
// Event listeners

ipc.on('start', () => {
  setPingReply(moduleIdent, ipc, 'running');
});

// Determine game type

// Determine download type

// Load up other config

// Check if game installed

// Download game

// Check for update
