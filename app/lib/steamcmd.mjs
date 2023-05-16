'use strict';

// Our libs
import { parseBool } from './parseBool.mjs';
import { timestamp } from './timestamp.mjs';
import { downloadFile } from './download.mjs';

// Nodejs stdlib
import { default as fs } from 'node:fs';

// External libs
import { default as pty } from 'node-pty';
import { default as elog } from 'ee-log';

// Loud but useful
const debug = parseBool(process.env.DEBUG) || false;

const steamcmdUrl =
  process.env.STEAMCMD_DOWNLOAD_URL || 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz';

//
// Download an application from Steam
export function steamCmdDownloadAppid(
  options = {
    appid: 0,
    validate: false,
    anonymous: true,
    username: '',
    password: '',
    steamCmdDir: '',
    serverFilesDir: '',
  },
) {
  return new Promise((resolve, reject) => {
    // steam appid to download/update
    // eslint-disable-next-line no-prototype-builtins
    var appid = options.hasOwnProperty('appid') ? options.appid : false;

    // do we force a validation check
    // eslint-disable-next-line no-prototype-builtins
    var validate = options.hasOwnProperty('validate') ? options.validate : false;

    // login anon or not
    // eslint-disable-next-line no-prototype-builtins
    var anonymous = options.hasOwnProperty('anonymous') ? options.anonymous : true;

    // if not anon, username
    // eslint-disable-next-line no-prototype-builtins
    var username = options.hasOwnProperty('username') ? options.username : null;

    // and password
    // eslint-disable-next-line no-prototype-builtins
    var password = options.hasOwnProperty('password') ? options.password : null;

    // eslint-disable-next-line no-prototype-builtins
    var steamCmdDir = options.hasOwnProperty('steamCmdDir') ? options.steamCmdDir : '';
    // eslint-disable-next-line no-prototype-builtins
    var serverFilesDir = options.hasOwnProperty('serverFilesDir') ? options.serverFilesDir : '';

    if (steamCmdDir === '' || serverFilesDir === '') {
      return reject(new Error('steamCmdDir and serverFilesDir required'));
    }

    // Verify caller provided an appid
    if (!parseBool(appid.toString())) {
      return reject(new Error('appid required'));
    }

    console.log(`[${timestamp()}] --- Spawning SteamCMD to download/update appid ${appid} in ${serverFilesDir} ---`);

    // Setup steamcmd command line / inline script
    const steamcmdCommandLine = [];

    // Setup install dir
    steamcmdCommandLine.push(`+force_install_dir "${serverFilesDir}"`);

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

    runSteamCmd({
      script: steamcmdCommandLine,
      steamCmdDir: steamCmdDir,
    })
      .then(() => {
        return resolve();
      })
      .catch((err) => {
        return reject(err);
      });
  });
}

//
// Download/Update steamcmd itself
export function steamCmdDownloadSelf(
  options = {
    force: false,
    steamCmdDir: '',
  },
) {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line no-prototype-builtins
    var steamCmdDir = options.hasOwnProperty('steamCmdDir') ? options.steamCmdDir : '';
    if (steamCmdDir === '') {
      return reject(new Error('steamCmdDir required'));
    }

    // If force is set, remove all steamcmd files
    if (options.force) {
      try {
        fs.rmSync(`${steamCmdDir}/linux32`, { recursive: true });
        fs.rmSync(`${steamCmdDir}/linux64`, { recursive: true });
        fs.rmSync(`${steamCmdDir}/(null)`, { recursive: true });
        fs.rmSync(`${steamCmdDir}/package`, { recursive: true });
        fs.rmSync(`${steamCmdDir}/public`, { recursive: true });
        fs.rmSync(`${steamCmdDir}/siteserverui`, { recursive: true });
        fs.rmSync(`${steamCmdDir}/steamcmd.sh`, { recursive: true });
        fs.rmSync(`${steamCmdDir}/steamcmd.tar`, { recursive: true });
      } catch (err) {
        // no-op
      }
    }

    fs.access(`${steamCmdDir}/steamcmd.sh`, fs.constants.F_OK | fs.constants.X_OKAY, async (err) => {
      // if we get an ENOENT error then the file doesn't exist
      if (err && err.code === 'ENOENT') {
        console.log(`[${timestamp()}] --- Downloading Initial SteamCMD Binary ---`);
        // Download the tar.gz from Valve
        // eslint-disable-next-line promise/no-promise-in-callback
        await downloadFile(steamcmdUrl, steamCmdDir, { untar: true });
      }
      console.log(`[${timestamp()}] --- Running SteamCMD to update self ---`);
      // eslint-disable-next-line promise/no-promise-in-callback
      // Setup steamcmd command line / inline script
      const steamcmdCommandLine = [];

      // All we need to do here is +quit
      steamcmdCommandLine.push('+quit');

      elog.debug(steamCmdDir);
      await runSteamCmd({ script: ['+quit'], steamCmdDir: steamCmdDir });
      return resolve();
    });
  });
}

//
// Run a SteamCMD cmdline script
export function runSteamCmd(
  options = {
    script: [],
    steamCmdDir: '',
  },
) {
  elog.debug(options);
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line no-prototype-builtins
    var steamCmdDir = options.hasOwnProperty('steamCmdDir') ? options.steamCmdDir : '';
    if (steamCmdDir === '') {
      return reject(new Error('steamCmdDir required'));
    }

    // optional http proxy to use
    // eslint-disable-next-line no-prototype-builtins, prettier/prettier
    var httpProxy = options.hasOwnProperty('httpProxy') ? options.httpProxy : null;

    // optional http proxy to use
    // eslint-disable-next-line no-prototype-builtins, prettier/prettier
    var script = options.hasOwnProperty('script') ? options.script : ['+quit'];

    // Setup steamcmd command line / inline script
    const steamcmdCommandLine = script;
    const steamcmdEnv = { LD_LIBRARY_PATH: `${options.steamCmdDir}/linux32` };

    // If httpProxy is set, set the envvar HTTP_PROXY
    httpProxy ? (steamcmdEnv.HTTP_PROXY = httpProxy) : null;

    // Ensure +quit is at the end of the cmdline
    steamcmdCommandLine.push('+quit');

    if (debug) elog.debug(steamcmdCommandLine);
    if (debug) elog.debug(steamcmdEnv);

    // Spawn steamcmd in a pty
    const steamcmdChild = pty.spawn(`${options.steamCmdDir}/steamcmd.sh`, steamcmdCommandLine, {
      handleFlowControl: true,
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd: options.steamCmdDir,
      env: steamcmdEnv,
    });

    // Setup some event listeners

    // When steamcmd outputs, output it to console
    // Yes we have to do that grossness where we split on '\r'
    // Valve doesn't know how to stdout
    steamcmdChild.onData((rawData) => {
      rawData = rawData.toString();
      var dataArray = rawData.split('\r');
      for (let i = 0; i < dataArray.length; i++) {
        // eslint-disable-next-line security/detect-object-injection
        var data = dataArray[i];
        if (data != '' && data != ' ') {
          process.stdout.write(`[${timestamp()}] ${data}`);
        }
      }
    });

    // When steamcmd is done, return the exitcode
    steamcmdChild.onExit((code) => {
      // first remove our onData listener from above (and any others that it might have picked up)
      steamcmdChild.removeAllListeners();
      // push a log msg
      console.log(
        `[${timestamp()}] --- Steamcmd exited with code ${code.exitCode} because of signal ${code.signal} ---`,
      );
      // TODO: standardize response to caller
      return resolve(code.exitCode);
    });

    // Handle SIGTERM when steamcmd is running
    process.on('SIGTERM', () => {
      steamcmdChild.kill('SIGTERM');
    });
  });
}
