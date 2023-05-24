'use strict';

// Our libs
import { downloadFile } from './fileDownload.mjs';
import { setupLog } from './log.mjs';

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
 * @param {Object.<Number, Boolean, Boolean, Boolean, String, String, String, String>} options
 * @param {Number} options.appid - the steam appid to download
 * @param {Boolean} options.serverFilesForce - if true, remove all old server files (DANGEROUS)
 * @param {Boolean} options.validate - validate the install after download
 * @param {Boolean} options.anonymous - login anonymous
 * @param {String} options.username - login username
 * @param {String} options.password - login password
 * @param {String} options.steamCmdDir - path to steamcmd install directory
 * @param {String} options.serverFilesDir - path to server files base directory
 * @param {Stream.Passthrough} outputSink - output sink for progress messages
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
      log.debug(`steamCmdDownloadAppid options.serverFilesForce is true, removing old server installation`);
      fs.rmSync(path.normalize(path.resolve(`${serverFilesDir}`)), { recursive: true, force: true });
    }

    // Create serverFilesDir if necessary
    fs.access(serverFilesDir, fs.constants.F_OK | fs.constants.W_OKAY, (error) => {
      if (error && error.code === 'ENOENT') {
        log.info(`Creating steamcmd directory at ${serverFilesDir}`);
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        fs.mkdirSync(serverFilesDir, {
          recursive: true,
          mode: 0o755,
        });
      } else {
        return reject(error);
      }
    });

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

    log.info(`Spawning SteamCMD to download/update appid ${appid} in ${serverFilesDir}`, 'info', 'steamcmd');

    // Now actually run steamcmd
    runSteamCmd(
      {
        script: steamcmdCommandLine,
        steamCmdDir: steamCmdDir,
      },
      outputSink,
    )
      .then(() => {
        return resolve(0);
      })
      .catch((error) => {
        return reject(error);
      });
  });
}

/**
 * Download/Update steamcmd itself
 * @param {Object.<Boolean, String>} options
 * @param {Boolean} options.force - remove existing steamcmd files before downloading
 * @param {String} options.steamCmdDir - path to steamcmd install directory
 * @param {Stream.Passthrough} outputSink - output sink for progress messages
 * @returns {Promise<Number>} resolves when download is complete, rejects on error
 */
export function steamCmdDownloadSelf(
  options = {
    force: false,
    steamCmdDir: '',
  },
  outputSink = Stream.PassThrough,
) {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line no-prototype-builtins
    var steamCmdDir = options.hasOwnProperty('steamCmdDir') ? options.steamCmdDir : '';
    if (steamCmdDir === '') {
      log.error('steamCmdDownloadSelf called without steamCmdDir');
      return reject(new Error('steamCmdDir required'));
    }

    // If force is set, remove all steamcmd files
    if (options.force) {
      log.debug(`steamCmdDownloadSelf options.force is true, removing old steamcmd installation`);
      fs.rmSync(path.normalize(path.resolve(`${steamCmdDir}`)), { recursive: true, force: true });
    }

    // Create steamCmdDir if necessary
    fs.access(steamCmdDir, fs.constants.F_OK | fs.constants.W_OKAY, (error) => {
      if (error && error.code === 'ENOENT') {
        log.info(`Creating steamcmd directory at ${steamCmdDir}`);
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        fs.mkdirSync(steamCmdDir, {
          recursive: true,
          mode: 0o755,
        });
      }
    });

    // Check to see if steamcmd.sh exists
    fs.access(
      path.normalize(path.resolve(`${steamCmdDir}/linux32/steamcmd`)),
      fs.constants.F_OK | fs.constants.X_OKAY,
      async (error) => {
        // if we get an ENOENT error then the file doesn't exist
        if (error && error.code === 'ENOENT') {
          log.info(`Downloading Initial SteamCMD Binary`);
          // Download the tar.gz from Valve and unpack it
          try {
            // eslint-disable-next-line promise/no-promise-in-callback
            await downloadFile(steamcmdUrl, steamCmdDir, { untar: true });
          } catch (error) {
            return reject(error);
          }
        }
        // Either steamcmd is already setup or we just downloaded it
        // Either way, run steamcmd.sh +quit to ensure its updated
        log.info(`Running SteamCMD to update self`);
        // eslint-disable-next-line promise/no-promise-in-callback
        // Setup steamcmd command line / inline script
        const steamcmdCommandLine = [];

        // All we need to do here is +quit
        steamcmdCommandLine.push('+quit');

        // Now actually run steamcmd
        // eslint-disable-next-line promise/no-promise-in-callback
        runSteamCmd(
          {
            script: steamcmdCommandLine,
            steamCmdDir: steamCmdDir,
          },
          outputSink,
        )
          .then(() => {
            return resolve(0);
          })
          .catch((error) => {
            return reject(error);
          });
      },
    );
  });
}

/**
 * Spawn SteamCMD to run a cmdline script
 * @param {Object.<String, String>} options
 * @param {String[]} options.script - steamcmd script to run
 * @param {String} options.steamCmdDir - steamcmd install directory
 * @param {Stream.Passthrough} outputSink - output sink for progress messages
 * @returns {Promise<Number>} resolves with steamcmd exit code when script is complete, rejects on error
 */
export function runSteamCmd(
  options = {
    script: [''],
    steamCmdDir: '',
  },
  outputSink = Stream.PassThrough,
) {
  return new Promise((resolve, reject) => {
    // Ensure steamCmdDir is provided
    // eslint-disable-next-line no-prototype-builtins
    var steamCmdDir = options.hasOwnProperty('steamCmdDir') ? options.steamCmdDir : '';
    if (steamCmdDir === '') {
      log.error('runSteamCmd called without steamCmdDir');
      return reject(new Error('steamCmdDir required'));
    }

    // steamcmd script to run
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
    for (var i = 0; i < logDisplayCmdline.length; i++) {
      // eslint-disable-next-line security/detect-object-injection
      if (logDisplayCmdline[i].includes('+login') && logDisplayCmdline[i] != '+login anonymous') {
        // eslint-disable-next-line security/detect-object-injection
        logDisplayCmdline[i] = '+login <redacted>';
      }
    }

    const steamcmdCommandLineNormalized = steamcmdCommandLine.join(' ').split(' ');

    log.debug(`Steamcmd script (runSteamCmd):`, logDisplayCmdline);
    log.debug(`Normalized steamcmd script (runSteamCmd):`, steamcmdCommandLineNormalized);

    // Spawn steamcmd in a pty
    const steamcmdChild = pty.spawn(
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

    // Setup some event listeners

    // When steamcmd outputs, output it to console
    // Yes we have to do that grossness where we split on '\r\n'
    // Valve doesn't know how to stdout
    // TODO: make this a transform stream
    steamcmdChild.onData((rawData) => {
      rawData = rawData.toString();
      var dataArray = rawData.split('\r\n');
      for (let i = 0; i < dataArray.length; i++) {
        // eslint-disable-next-line security/detect-object-injection
        var data = dataArray[i];
        if (data != '') {
          log.debug(data);
          outputSink.push(data);
        }
      }
    });

    // Hook steamcmd exit
    steamcmdChild.onExit(async (code) => {
      // first remove our onData listener from above (and any others that it might have picked up)
      steamcmdChild.removeAllListeners();
      // push a log msg
      log.info(`Steamcmd exited with code ${code.exitCode} because of signal ${code.signal}`);

      // if exit code is 42, we need to re-launch steamcmd
      if (code.exitCode === 42) {
        // Spawn steamcmd again, saving the exit code to retryExitCode
        log.info('Steamcmd exited with code 42, re-launching...');
        outputSink.push('Steamcmd exited with code 42, re-launching...');
        var retryExitCode = null;
        try {
          retryExitCode = await runSteamCmd(options, outputSink);
        } catch (error) {
          log.error(error);
          return reject(error);
        }

        // Resolve it regardless, caller will make sure we re-run if it's 42 again
        return resolve(retryExitCode);
      } else if (code.exitCode === 0) {
        return resolve(code.exitCode);
      } else {
        return reject(new Error(`Steamcmd exited with code ${code.exitCode} because of signal ${code.signal}`));
      }
    });

    steamCmdChildSignalForwarder.removeAllListeners();
    steamCmdChildSignalForwarder.once('exitSignal', () => {
      process.stdout.write('\n');
      log.info('Caught SIGTERM/SIGINT while running steamcmd, sending SIGTERM...');
      steamcmdChild.kill('SIGTERM');
      return reject(new Error('SHUTDOWN'));
    });
  });
}
