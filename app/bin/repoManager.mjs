'use strict';

// Repo manager
// Downloads server configuration from a repo
// TODO: apply secrets from envvars?
// TODO: like workshop api key in some mod config

// Our libs
import { setupIpc, setPingReply, sendRequestReply } from '../lib/ipc.mjs';
import { releaseLock, spinLock, spinClear } from '../lib/lock.mjs';
import { setupTerminationSignalHandlers } from '../lib/exitHandlers.mjs';
import { setupLog, isoTimestamp } from '../lib/log.mjs';
import { getDirName } from '../lib/dirname.mjs';
import { parseBool } from '../lib/parseBool.mjs';

// External libs
import { simpleGit } from 'simple-git';

// Nodejs stdlib
import { default as path } from 'node:path';
import { default as crypto } from 'node:crypto';
import { default as Stream } from 'node:stream';

//
// Start boilerplate
// Debug modes
const debug = parseBool(process.env.DEBUG) || false;

// Module id
const moduleIdent = 'repoManager';

// Populate __dirname
const __dirname = getDirName();

// Setup logger
const log = setupLog('bin/repoManager.mjs');

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
const runningDownloads = {};

//
// Start logic

// Setup git library
const git = simpleGit();

// Tell everyone we're alive
ipc.on('start', () => {
  setPingReply(moduleIdent, ipc, 'ready');
});

// Listen for downloadUpdateRepo requests
ipc.subscribe('configManager.downloadUpdateRepo', downloadUpdateRepo);

/**
 * Download/update a git repo/branch to a directory
 * @param {Object.<String, Boolean>} ipcData - the request as delivered by IPC
 * @param {String} ipcData.requestId - uuidv4 - requestId
 * @param {String} ipcData.replyTo - `${moduleIdent}.${requestId}`
 * @param {Object.<String, Boolean>} ipcData.message - actual request
 * @param {String} ipcData.message.repoUrl - repo url
 * @param {String} ipcData.message.repoBranch - repo branch
 * @param {String} ipcData.message.repoDir - parent dir for config storage
 * @param {String} ipcData.message.instanceId - instancdid - my-casual-server
 */
async function downloadUpdateRepo(ipcData) {
  ipcData = JSON.parse(ipcData);
  log.info('Incoming downloadUpdateRepo request:', ipcData);
  const request = ipcData.message;
  request.requestId = ipcData.requestId;
  request.replyTo = ipcData.replyTo;

  // Verify caller provided a repo url
  if (!request.repoUrl) {
    log.error('downloadUpdateRepo called without repoUrl, sending error');
    sendRequestReply(moduleIdent, ipc, 'error', { error: new Error('repoUrl required') }, request);
    return;
  }
  // And repo branch
  if (!request.repoBranch) {
    log.warn('downloadUpdateRepo called without repoBranch, defaulting to "main"');
    request.repoBranch = 'main';
  }
  // And a directory to clone the repo to
  if (!request.repoDir) {
    log.error('downloadUpdateRepo called without repoDir, sending error');
    sendRequestReply(moduleIdent, ipc, 'error', { error: new Error('repoDir required') }, request);
    return;
  }

  // Used below
  // Global "we're downloading stuff" lock
  const globalLockId = `repoDownload-${request.instanceId}`;
  // Pattern to check for spinClear below
  const configMountLockCheckPattern = `^configMount-${request.instanceId}$`;

  // If the download appears to be running
  if (request.instanceId in runningDownloads) {
    // If so, send the NACK along with the channel id they can sub to for progress messages
    log.warn('Transaction appears to be in progress, sending NACK');
    sendRequestReply(
      moduleIdent,
      ipc,
      'nack',
      {
        alreadyRequested: true,
        reason: 'already requested',
        subscribeTo: runningDownloads[request.instanceId].request.replyTo,
        requestId: runningDownloads[request.instanceId].request.requestId,
        request: runningDownloads[request.instanceId].request,
      },
      request,
    );
    return;
  } else {
    // Create the status tracking object
    runningDownloads[request.instanceId] = {
      request: request,
      instanceId: request.instanceId,
      downloadLocked: true,
      downloadState: earlyState,
      lastLog: [],
      progressSnapshot: {},
      error: null,
    };
  }

  // Early status message - our runningDownloads object doesn't exist yet
  var earlyState = 'checking locks';

  // First acquire a config download lock for the instance
  try {
    await spinLock(globalLockId, 30);
  } catch (error) {
    log.error(`Error while spinLocking on ${globalLockId}`, error);
    sendRequestReply(moduleIdent, ipc, 'error', { error: error }, request);
    return;
  }

  // Make sure nobody has config files mounted
  try {
    // spinClear on our "config files are mounted somewhere" pattern
    await spinClear(configMountLockCheckPattern, 30);
  } catch (error) {
    // We keep globalLockId active - manual cleanup may be required on an unknown error condition
    log.error(`Error while spinClearing on ${configMountLockCheckPattern}`, error);
    sendRequestReply(moduleIdent, ipc, 'error', { error: error }, request);
    delete runningDownloads[request.instanceId];
    await releaseLock(globalLockId);
    return;
  }

  // Prepare a variable to hold our download result
  var result = false;

  // Setup an output stream to forward logs through
  runningDownloads[request.instanceId].outputSink = new Stream.PassThrough({ end: false });
  // And another for progress indicators
  runningDownloads[request.instanceId].progressSink = new Stream.PassThrough({ end: false });
  // This one is for sending commands down to the download controller
  runningDownloads[request.instanceId].commandSink = new Stream.PassThrough({ end: false });

  // When it receives something, forward it to ipc
  runningDownloads[request.instanceId].outputSink.on('data', (data) => {
    const output = data.toString();
    // Add the line to lastLog
    runningDownloads[request.instanceId].lastLog.unshift(output);
    // Truncate lastLog
    runningDownloads[request.instanceId].lastLog.length = Math.min(
      runningDownloads[request.instanceId].lastLog.length,
      1000,
    );
    // Tell the caller we have some output
    sendRequestReply(moduleIdent, ipc, 'output', { line: output }, request);
  });
  // Let everyone else know what we're doing
  setPingReply(moduleIdent, ipc, 'downloading');

  // Then ack the request
  sendRequestReply(
    moduleIdent,
    ipc,
    'ack',
    {
      subscribeTo: request.replyTo,
      requestId: request.requestId,
    },
    request,
  );

  // Download the repo
  if (debug) log.debug(`About to clone ${request.repoUrl} to ${request.repoDir}`);

  // Setup the progress handler
  const gitProgress = (method, stage, progress) => {
    const line = `git.${method} ${stage} stage ${progress}% complete`;
    log.debug(line);
    // Add the line to lastLog
    runningDownloads[request.instanceId].lastLog.unshift(line);
    // Truncate lastLog
    runningDownloads[request.instanceId].lastLog.length = Math.min(
      runningDownloads[request.instanceId].lastLog.length,
      1000,
    );
    // Tell the caller we have some output
    sendRequestReply(moduleIdent, ipc, 'output', { line: line }, request);
  };

  // Attempt to clone the repo
  try {
    await git.clone(request.repoUrl, path.resolve(request.repoDir), {
      progress: gitProgress,
    });
  } catch (error) {
    log.error(error);
    sendRequestReply(moduleIdent, ipc, 'error', { error: error }, request);
    delete runningDownloads[request.instanceId];
    await releaseLock(globalLockId);
    return;
  }

  // Send a response
  result = {
    status: 'completed',
  };
  // Send a final reply to the request
  sendRequestReply(moduleIdent, ipc, 'finalStatus', result, request);

  // Done
  setPingReply(moduleIdent, ipc, 'ready');
}
