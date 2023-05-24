'use strict';

// coordinator

// Steamcmd install directory
const _steamCmdDir = process.env.STEAMCMD_DIR || '/opt/steamcmd';
const steamCmdDir = path.resolve(path.normalize(_steamCmdDir));


// Pull gameID from ennvvars
const gameID = process.env.GAME_ID || 'csgo';
