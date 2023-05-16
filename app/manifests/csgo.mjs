'use strict';

export const manifest = {
  name: 'csgo', // must be one word. should be all lowercase. no - _ . characters allowed
  displayName: 'Counter-Strike: Global Offensive', // whatever you want
  downloadType: 'steamcmd', // steamcmd is the only implemented method at this time
  downloadId: '740', // steam appid
  binDir: './', // relative to serverFilesBaseDir
  binName: 'srcds_linux', // binary to run
};
