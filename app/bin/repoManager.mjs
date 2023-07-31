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
import { default as fs } from 'node:fs';
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

// Tell everyone we're alive
ipc.on('start', () => {
  setPingReply(moduleIdent, ipc, 'ready');
});

// Listen for downloadUpdateRepo requests
ipc.subscribe('configManager.downloadUpdateRepo', downloadUpdateRepo);

/**
 * Download/update a git repo/branch to a directory
 * @param {Object.<String, Boolean>} request - the request as delivered by IPC
 * @param {String} request.requestId - uuidv4 - requestId
 * @param {String} request.replyTo - `${moduleIdent}.${requestId}`
 * @param {String} request.repoUrl - repo url
 * @param {String} request.repoBranch - repo branch
 * @param {String} request.repoDir - parent dir for config storage
 * @param {String} request.instanceId - instanceId - my-casual-server
 * @param {String} request.action - git action to take (clone | pull)
 * @param {Boolean} request.clean - force remove old repo directory before cloning
 */
async function downloadUpdateRepo(request) {
  request = JSON.parse(request);
  log.info('Incoming downloadUpdateRepo request:', request);

  // eslint-disable-next-line no-prototype-builtins
  request.force = request.hasOwnProperty('force') ? parseBool(request.force) : false;

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
    if (debug) log.debug('Attempting to acquire global repoManager lock');
    await spinLock(globalLockId, 30);
  } catch (error) {
    log.error(`Error while spinLocking on ${globalLockId}`, error);
    sendRequestReply(moduleIdent, ipc, 'error', { error: error }, request);
    return;
  }

  // Make sure nobody has config files mounted
  try {
    // spinClear on our "config files are mounted somewhere" pattern
    if (debug) log.debug('Waiting for config locks to clear');
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

  // When outputSink receives something, forward it to ipc
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

  // Setup the progress handler (we do it in here so we have access to the request object)
  const gitProgress = (info) => {
    if (info != null) {
      var method = '';
      var stage = '';
      var progress = '';
      // eslint-disable-next-line no-prototype-builtins
      if (info.hasOwnProperty('method')) method = info.method;

      // eslint-disable-next-line no-prototype-builtins
      if (info.hasOwnProperty('stage')) stage = info.stage;

      // eslint-disable-next-line no-prototype-builtins
      if (info.hasOwnProperty('progress')) progress = info.progress;

      const line = `git.${method} ${stage} ${progress}%`;
      if (debug) log.debug(line);
      // Add the line to lastLog
      runningDownloads[request.instanceId].lastLog.unshift(line);
      // Truncate lastLog
      runningDownloads[request.instanceId].lastLog.length = Math.min(
        runningDownloads[request.instanceId].lastLog.length,
        1000,
      );
      // Tell the caller we have some output
      sendRequestReply(
        moduleIdent,
        ipc,
        'output',
        {
          line: {
            timestamp: isoTimestamp(),
            line: line,
          },
        },
        request,
      );
    }
    if (debug) log.debug(info);
  };

  const repoParentTempPath = request.repoDir.split('/');
  repoParentTempPath.pop();
  const repoParentDir = path.resolve(repoParentTempPath.join('/'));
  if (debug) log.debug(`Working in dir ${repoParentDir}`);

  switch (request.action) {
    // They want git clone
    case 'clone':
      // Attempt to clone the repo
      try {
        // Clean up old game files if specified
        if (request.clean) {
          if (debug) {
            const line = 'downloadUpdateRepo request.clean is true, removing existing on disk repo';
            log.warn(line);
          }
          fs.rmSync(path.resolve(request.repoDir), { recursive: true, force: true });
        }
        // Setup git library
        var git = simpleGit({
          baseDir: repoParentDir,
          progress: gitProgress,
        });

        // Do the git clone
        if (debug) log.debug(`Cloning ${request.repoUrl}`);
        await git.clone(request.repoUrl, path.resolve(request.repoDir));

        // Checkout the specified branch/tag/commit
        if (debug) log.debug(`Checking out ${request.repoBranch}`);
        git = simpleGit({
          baseDir: path.resolve(request.repoDir),
          progress: gitProgress,
        });
        await git.checkout(request.repoBranch);
      } catch (error) {
        // Log and reply with errors
        log.error(error);
        sendRequestReply(moduleIdent, ipc, 'error', { error: error.message }, request);
        delete runningDownloads[request.instanceId];
        await releaseLock(globalLockId);
        setPingReply(moduleIdent, ipc, 'error');
        return;
      }
      break;
    // They want git pull
    case 'pull':
      // Attempt to run git pull on the repo
      try {
        // Setup git library
        const git = simpleGit({
          baseDir: path.resolve(request.repoDir),
          progress: gitProgress,
        });

        // Do the git pull
        if (debug) log.debug(`Pulling ${request.repoUrl}`);
        await git.pull({ '--ff-only': null });

        // Checkout the specified branch/tag/commit
        if (debug) log.debug(`Checking out ${request.repoBranch}`);
        await git.checkout(request.repoBranch);
      } catch (error) {
        // Log and reply with errors
        log.error(error);
        sendRequestReply(moduleIdent, ipc, 'error', { error: error.message }, request);
        delete runningDownloads[request.instanceId];
        await releaseLock(globalLockId);
        setPingReply(moduleIdent, ipc, 'error');
        return;
      }
      break;
    // Anything else
    default:
      // We don't know how to handle this
      sendRequestReply(moduleIdent, ipc, 'error', { error: 'unsupported git action' }, request);
      delete runningDownloads[request.instanceId];
      await releaseLock(globalLockId);
      setPingReply(moduleIdent, ipc, 'error');
      return;
  }

  // Send a response
  result = {
    status: 'completed',
  };
  // Send a final reply to the request
  sendRequestReply(moduleIdent, ipc, 'finalStatus', result, request);

  delete runningDownloads[request.instanceId];
  await releaseLock(globalLockId);

  // Done
  setPingReply(moduleIdent, ipc, 'ready');
}
