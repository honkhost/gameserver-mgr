'use strict';

// Our libs
import { downloadFile } from './fileDownload.mjs';
import { setupLog, isoTimestamp } from './log.mjs';

// Nodejs stdlib
import { default as fs } from 'node:fs';
import { default as events } from 'node:events';
import { default as Stream } from 'node:stream';
import { default as path } from 'node:path';

// External libs
import { default as pty } from 'node-pty';

const log = setupLog('lib/steamcmd.mjs');

// Download url for initial steamcmd binary
const steamcmdUrl =
  process.env.STEAMCMD_DOWNLOAD_URL || 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz';

// Signal forwarder for steamcmd child processes
// We need this so we don't attach multiple listeners to process.on('SIGTERM')
// that we then have problems cleaning up later on
const steamCmdChildSignalForwarder = new events.EventEmitter();

// Handle SIGTERM when steamcmd is running
process.on('SIGTERM', () => {
  steamCmdChildSignalForwarder.emit('exitSignal');
});
// Handle SIGINT when steamcmd is running
process.on('SIGINT', () => {
  steamCmdChildSignalForwarder.emit('exitSignal');
});

/**
 * Download an application from Steam
 * @param {Object.<Number, Boolean, String>} options
 * @param {Number} options.appid - the steam appid to download
 * @param {Boolean} options.serverFilesForce - if true, remove all old server files (DANGEROUS)
 * @param {Boolean} options.validate - validate the install after download
 * @param {Boolean} options.anonymous - login anonymous
 * @param {String} options.username - login username
 * @param {String} options.password - login password
 * @param {String} options.steamCmdDir - path to steamcmd install directory
 * @param {String} options.serverFilesDir - path to server files base directory
 * @param {Stream.Passthrough} outputSink - output sink for verbose messages
 * @param {Stream.Passthrough} progressSink - output sink for progress messages
 * @param {Stream.PassThrough} commandSink - input sink for commands (currently only supports "cancel")
 * @returns {Promise<Number>} resolves when download is complete, rejects on error
 */
export function steamCmdDownloadAppid(
  options = {
    appid: 0,
    serverFilesForce: false,
    validate: false,
    anonymous: true,
    username: '',
    password: '',
    steamCmdDir: '',
    serverFilesDir: '',
  },
  outputSink = Stream.PassThrough,
  progressSink = Stream.PassThrough,
  commandSink = Stream.PassThrough,
) {
  return new Promise((resolve, reject) => {
    // steam appid to download/update
    // eslint-disable-next-line no-prototype-builtins
    const appid = options.hasOwnProperty('appid') ? options.appid : 0;

    // (dangerous!) force remove all server files before installing
    // eslint-disable-next-line no-prototype-builtins
    const serverFilesForce = options.hasOwnProperty('serverFilesForce') ? options.serverFilesForce : false;

    // do we force a validation check
    // eslint-disable-next-line no-prototype-builtins
    const validate = options.hasOwnProperty('validate') ? options.validate : false;

    // login anon or not
    // eslint-disable-next-line no-prototype-builtins
    const anonymous = options.hasOwnProperty('anonymous') ? options.anonymous : true;

    // if not anon, username
    // eslint-disable-next-line no-prototype-builtins
    const username = options.hasOwnProperty('username') ? options.username : null;

    // and password
    // eslint-disable-next-line no-prototype-builtins
    const password = options.hasOwnProperty('password') ? options.password : null;

    // default steamCmdDir to empty string
    // eslint-disable-next-line no-prototype-builtins, prettier/prettier
    const steamCmdDir = options.hasOwnProperty('steamCmdDir') 
      ? path.normalize(path.resolve(options.steamCmdDir)) 
      : '';

    // and serverFilesDir
    // eslint-disable-next-line no-prototype-builtins
    const serverFilesDir = options.hasOwnProperty('serverFilesDir')
      ? path.normalize(path.resolve(options.serverFilesDir))
      : '';

    // If either are empty, bail out
    if (steamCmdDir === '' || serverFilesDir === '') {
      log.error('steamCmdDownloadAppid called without steamCmdDir or serverFilesDir');
      return reject(new Error('steamCmdDir and serverFilesDir required'));
    }

    // Verify caller provided an appid
    if (!appid) {
      log.error('steamCmdDownloadAppid called without appid');
      return reject(new Error('appid required'));
    }

    // Clean up old game files if specified
    if (serverFilesForce) {
      if (process.env.DEBUG) {
        log.debug(`steamCmdDownloadAppid options.serverFilesForce is true, removing old server installation`);
      }
      fs.rmSync(path.normalize(path.resolve(`${serverFilesDir}`)), { recursive: true, force: true });
    }

    // Create serverFilesDir if necessary
    fs.access(serverFilesDir, fs.constants.F_OK | fs.constants.W_OKAY, (error) => {
      if (error && error.code === 'ENOENT') {
        log.info(`Creating server files directory at ${serverFilesDir}`);
        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          fs.mkdirSync(path.normalize(path.resolve(`${serverFilesDir}`)), {
            recursive: true,
            mode: 0o755,
          });
        } catch (error2) {
          log.error(error2);
          return reject(error2);
        }
      } else {
        log.error(error);
        return reject(error);
      }
    });
    log.debug('here');

    // Setup steamcmd command line / inline script
    const steamcmdCommandLine = [];

    // Setup install dir
    // eslint-disable-next-line no-useless-escape
    steamcmdCommandLine.push(`+force_install_dir ${serverFilesDir}`);

    // Handle login credentials
    anonymous
      ? steamcmdCommandLine.push('+login anonymous')
      : steamcmdCommandLine.push(`+login ${username} ${password}`);

    // Handle validation
    validate
      ? steamcmdCommandLine.push(`+app_update ${appid} validate`)
      : steamcmdCommandLine.push(`+app_update ${appid}`);

    // Quit at the end
    steamcmdCommandLine.push('+quit');

    // Log that we're about to run steamcmd
    log.info(`Spawning SteamCMD to download/update appid ${appid} in ${serverFilesDir}`);

    // Now actually run steamcmd
    runSteamCmd(
      {
        script: steamcmdCommandLine,
        steamCmdDir: steamCmdDir,
      },
      outputSink,
      progressSink,
      commandSink,
    )
      .then((result) => {
        // Bubble up the exit code
        return resolve(result);
      })
      .catch((error) => {
        // Bubble up errors too
        log.error(error);
        return reject(error);
      });
  });
}

/**
 * Download/Update steamcmd itself
 * @param {Object.<Boolean, String>} options
 * @param {Boolean} options.force - remove existing steamcmd files before downloading
 * @param {String} options.steamCmdDir - path to steamcmd install directory
 * @returns {Promise<Number>} resolves when download is complete, rejects on error
 */
export function steamCmdDownloadSelf(
  options = {
    force: false,
    steamCmdDir: '',
  },
) {
  return new Promise((resolve, reject) => {
    // Verify steamCmdDir was provided, reject if it wasn't
    // eslint-disable-next-line no-prototype-builtins
    var steamCmdDir = options.hasOwnProperty('steamCmdDir') ? options.steamCmdDir : '';
    if (steamCmdDir === '') {
      log.error('steamCmdDownloadSelf called without steamCmdDir');
      return reject(new Error('steamCmdDir required'));
    }

    // If force is set, remove all steamcmd files
    if (options.force) {
      if (process.env.DEBUG) {
        log.debug(`steamCmdDownloadSelf options.force is true, removing old steamcmd installation`);
      }
      fs.rmSync(path.normalize(path.resolve(`${steamCmdDir}`)), { recursive: true, force: true });
    }

    // Create steamCmdDir if necessary
    fs.access(steamCmdDir, fs.constants.F_OK | fs.constants.W_OKAY, (error) => {
      if (error && error.code === 'ENOENT') {
        log.info(`Creating steamcmd directory at ${steamCmdDir}`);
        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          fs.mkdirSync(path.normalize(path.resolve(`${steamCmdDir}`)), {
            recursive: true,
            mode: 0o755,
          });
        } catch (error) {
          return reject(error);
        }
      }
    });

    // Check to see if steamcmd exists and we can execute it
    fs.access(
      path.normalize(path.resolve(`${steamCmdDir}/linux32/steamcmd`)),
      fs.constants.F_OK | fs.constants.X_OKAY,
      async (error) => {
        // if we get an ENOENT error then the file doesn't exist
        if (error && error.code === 'ENOENT') {
          log.info(`Downloading Initial SteamCMD Binary`);
          // Download the tar.gz from Valve and unpack it
          try {
            fs.rmSync(path.normalize(path.resolve(`${steamCmdDir}`)), { recursive: true, force: true });
            // eslint-disable-next-line security/detect-non-literal-fs-filename
            fs.mkdirSync(path.normalize(path.resolve(`${steamCmdDir}`)), {
              recursive: true,
              mode: 0o755,
            });
            await downloadFile(steamcmdUrl, steamCmdDir, { untar: true });
            return resolve();
          } catch (error) {
            // Bubble up any errors
            return reject(error);
          }
        }
      },
    );
  });
}

/**
 * Spawn SteamCMD to run a cmdline script
 * @param {Object.<String, String>} options
 * @param {String[]} options.script - steamcmd script to run
 * @param {String} options.steamCmdDir - steamcmd install directory
 * @param {Stream.Passthrough} outputSink - output sink for verbose messages
 * @param {Stream.Passthrough} progressSink - output sink for progress messages
 * @param {Stream.PassThrough} commandSink - input sink for commands (currently only supports "cancel")
 * @returns {Promise<Number>} resolves with steamcmd exit code when script is complete, rejects on error
 */
export function runSteamCmd(
  options = {
    script: [''],
    steamCmdDir: '',
  },
  outputSink = Stream.PassThrough, // raw output
  progressSink = Stream.PassThrough, // parsed progress messages
  commandSink = Stream.PassThrough, // to kill steamcmd if needed
) {
  return new Promise((resolve, reject) => {
    // Ensure steamCmdDir is provided, reject if it isn't
    // eslint-disable-next-line no-prototype-builtins
    var steamCmdDir = options.hasOwnProperty('steamCmdDir') ? options.steamCmdDir : '';
    if (steamCmdDir === '') {
      log.error('runSteamCmd called without steamCmdDir');
      return reject(new Error('steamCmdDir required'));
    }

    // Steamcmd script to run
    // eslint-disable-next-line no-prototype-builtins, prettier/prettier
    var script = options.hasOwnProperty('script') ? options.script : ['+quit'];

    // Setup steamcmd command line / inline script
    const steamcmdCommandLine = script;
    // And runtime env
    const steamcmdEnv = { LD_LIBRARY_PATH: `${options.steamCmdDir}/linux32` };

    // Ensure +quit is at the end of the cmdline
    steamcmdCommandLine[steamcmdCommandLine.length] === '+quit' ? steamcmdCommandLine.push('+quit') : null;

    // Remove username/password from log output
    const logDisplayCmdline = structuredClone(steamcmdCommandLine);
    // Run across the array
    for (var i = 0; i < logDisplayCmdline.length; i++) {
      // If it's the +login statement but isn't anon, redact the username/password
      // eslint-disable-next-line security/detect-object-injection
      if (logDisplayCmdline[i].includes('+login') && logDisplayCmdline[i] != '+login anonymous') {
        // eslint-disable-next-line security/detect-object-injection
        logDisplayCmdline[i] = '+login <redacted>';
      }
    }

    // Convert ["+login anonymous"] into ["+login", "anonymous"] and etc
    const steamcmdCommandLineNormalized = steamcmdCommandLine.join(' ').split(' ');

    // Log our sanitized steamcmd script
    if (process.env.DEBUG) {
      log.debug(`Steamcmd script (runSteamCmd):`, logDisplayCmdline);
    }

    // Setup the steamcmdChild variable up here
    var steamcmdChild = null;

    // And a "cancel in progress" one
    var cancelInProgress = false;

    try {
      // Spawn steamcmd in a pty
      steamcmdChild = pty.spawn(
        path.normalize(path.resolve(`${options.steamCmdDir}/linux32/steamcmd`)),
        steamcmdCommandLineNormalized,
        {
          handleFlowControl: true,
          name: 'xterm-color',
          cols: 80,
          rows: 30,
          cwd: options.steamCmdDir,
          env: steamcmdEnv,
        },
      );
    } catch (error) {
      log.error('error spawning steamcmd:', error);
      return reject(error);
    }

    // Listen to commandSink for cancel commands
    commandSink.on('data', (command) => {
      command = JSON.parse(command);
      if (command.command === 'cancel') {
        cancelInProgress = true;
        steamcmdChild.kill('SIGTERM');
        steamcmdChild.onExit((exitCode) => {
          exitCode.reason = 'canceled';
          commandSink.push(JSON.stringify(exitCode));
          return resolve(exitCode);
        });
      }
    });

    // When steamcmd outputs, output it to console
    // Yes we have to do that grossness where we split on '\r\n'
    // Valve doesn't know how to stdout
    // TODO: make this a transform stream (lol you wish)
    steamcmdChild.onData((rawData) => {
      // First make sure it's a string (you never know...)
      rawData = rawData.toString();
      // Split it on newlines (thanks valve)
      var dataArray = rawData.split('\r\n');
      // Run across the array we just created
      for (let i = 0; i < dataArray.length; i++) {
        // eslint-disable-next-line security/detect-object-injection
        const line = dataArray[i];
        // If that element isn't empty string (empty line)
        if (line != '') {
          if (process.env.DEBUG_STEAMCMD) {
            log.info(line);
          }
          // And push to outputSink
          outputSink.push(
            JSON.stringify({
              timestamp: isoTimestamp(),
              line: line,
            }),
          );

          //
          // Parse it for progress indications
          //
          // Downloading steamcmd
          const steamCmdDownloadStateRegex = /^\[\s{0,2}([0-9]+)%\] ([A-Za-z]+).*\(([0-9]+) of ([0-9]+).*$/;
          if (steamCmdDownloadStateRegex.test(line)) {
            // Build the progress object to send out
            const progressSnapshot = {
              downloadStage: 'steamcmd_download',
              downloadStateHex: '0x00',
              downloadState: null,
              downloadProgress: null,
              downloadProgressReceived: null,
              downloadProgressTotal: null,
              progressLine: line,
            };

            // Run the regex
            const steamCmdDownloadStateMatch = line.match(steamCmdDownloadStateRegex);

            // Pull the matches out
            progressSnapshot.downloadState = steamCmdDownloadStateMatch[2].toLowerCase();
            progressSnapshot.downloadProgress = steamCmdDownloadStateMatch[1].trim();
            progressSnapshot.downloadProgressReceived = steamCmdDownloadStateMatch[3];
            progressSnapshot.downloadProgressTotal = steamCmdDownloadStateMatch[4];

            // Send out the object
            progressSink.push(JSON.stringify(progressSnapshot));
          }

          //
          // Downloading an appid
          // Update state (0x61) downloading, progress: NN.NN
          const appidDownloadStateRegex =
            /^(?: Update state )\(([0-9]x[0-9]+)\) ([A-Za-z ]*).*([0-9]+\.[0-9]+) \(([0-9]+)(?: \/ )([0-9]+)\)$/;
          if (appidDownloadStateRegex.test(line)) {
            // Build the progress object to send out
            const progressSnapshot = {
              downloadStage: 'appid_download',
              downloadStateHex: null,
              downloadState: null,
              downloadProgress: null,
              downloadProgressReceived: null,
              downloadProgressTotal: null,
              progressLine: line,
            };

            // Run the regex
            const downloadStateMatch = line.match(appidDownloadStateRegex);

            // Pull matches out
            progressSnapshot.downloadStateHex = downloadStateMatch[1];
            progressSnapshot.downloadState = downloadStateMatch[2];
            progressSnapshot.downloadProgress = downloadStateMatch[3];
            progressSnapshot.downloadProgressReceived = downloadStateMatch[4];
            progressSnapshot.downloadProgressTotal = downloadStateMatch[5];

            // Send the object
            progressSink.push(JSON.stringify(progressSnapshot));
          }
        }
      }
    });

    // Hook steamcmd exit
    steamcmdChild.onExit(async (code) => {
      // first remove our onData listener from above (and any others that it might have picked up)
      steamcmdChild.removeAllListeners();
      // push a log msg
      if (process.env.DEBUG) {
        log.debug(`Steamcmd exited with code ${code.exitCode} because of signal ${code.signal}`);
      }

      // if exit code is 42, we need to re-launch steamcmd
      if (cancelInProgress) {
        log.info('Download canceled on request');
        outputSink.push(
          JSON.stringify({
            timestamp: isoTimestamp(),
            line: 'Download canceled on request',
          }),
        );
        code.reason = 'canceled';
        return resolve(code);
      } else if (code.exitCode === 42 || code.signal === 7) {
        // Spawn steamcmd again, saving the exit code to retryExitCode
        if (process.env.DEBUG) {
          log.debug(`Steamcmd exited with code ${code.exitCode} due to signal ${code.signal}, re-launching...`);
        }
        outputSink.push(
          JSON.stringify({
            timestamp: isoTimestamp(),
            line: `Steamcmd exited with code ${code.exitCode} due to signal ${code.signal}, re-launching...`,
          }),
        );
        // Holder for our retry exitcode
        var retryExitCode = null;
        try {
          // Run steamcmd again
          retryExitCode = await runSteamCmd(options, outputSink, progressSink, commandSink);
        } catch (error) {
          // Log and reject errors
          return reject(error);
        }
        // Resolve it regardless, caller will make sure we re-run if it's 42 again
        return resolve(retryExitCode);
      } else if (code.exitCode === 0) {
        // If exit code is 0, we're done
        code.reason = 'completed';
        return resolve(code);
      } else {
        // Otherwise reject any unknown exit codes
        // TODO: come back and implement retries for known exit codes
        log.warn(`Steamcmd exited with code ${code.exitCode} because of signal ${code.signal}`);
        return reject(code);
      }
    });

    // Cleanup exitSignal emitter
    steamCmdChildSignalForwarder.removeAllListeners();
    // And add a listener to handle sigterm/sigint
    steamCmdChildSignalForwarder.once('exitSignal', () => {
      process.stdout.write('\n');
      log.info('Caught SIGTERM/SIGINT while running steamcmd, sending SIGTERM...');
      steamcmdChild.kill('SIGTERM');
      return reject(new Error('SHUTDOWN'));
    });
  });
}
