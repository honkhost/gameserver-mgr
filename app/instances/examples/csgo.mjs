'use strict';

export const instance = {
  //
  // General gameserver info
  //

  // Info to load for this gameserver type, must have a matching manifest in app/manifests
  name: 'csgo',

  // Just a uuidv4 for internal use
  // Don't use this one - go here to generate a new one (or use your own tooling):
  // https://www.uuidgenerator.net/version4
  uuid: 'adc8f3bc-f328-469f-b29b-d7e18133f665',

  // Displayname for admin tools
  displayName: 'A Honk.Host Example Casual Server',

  // Only exposed to localhost in example docker-compose.yml, use with care if running otherwise
  rcon: true,
  port: 27015,
  maxplayers: 20,

  //
  // SRCDS parameters
  //

  //
  // Auth tokens
  // STRONGLY recommended that you create a dedicated steam account for these two tokens:
  // Gameserver Login Token (GSLT) (required to be publicly listed and to disable sv_lan)
  // https://steamcommunity.com/dev/managegameservers
  srcds_gslt: '',

  // Workshop api key (can be omitted if you don't need workshop access)
  // https://steamcommunity.com/dev/apikey
  srcds_wsapikey: '',

  //
  // Startup parameters
  // Startup map
  srcds_startupMap: 'de_nuke', // best map

  // Startup hostname as displayed to clients (can be changed with configs later on)
  srcds_hostname: 'A Honk.Host Example Casual Server',

  // Startup tickrate (can be changed with sourcemod plugin later on)
  srcds_tickRate: 64, // srcds default

  // Client access password
  srcds_password: 'sekrit',

  //
  // CSGO specific parameters
  //

  // Startup game_type and game_mode
  // https://developer.valvesoftware.com/wiki/Counter-Strike:_Global_Offensive/Game_Modes
  // 0, 0 = casual
  // 0, 1 = competitive
  // 1, 2 = deathmatch
  csgo_gameType: 1,
  csgo_gameMode: 2,

  //
  // Advanced overrides
  //

  // Override binary pwd and name
  binDirOverride: false, // relative to serverFilesBaseDir
  binNameOverride: false, // binary to run (override manifests/<game>.mjs)

  // Override the computed gameserver cmdline
  cmdlineOverride: false,
  // cmdlineOverride: [
  //   '-game csgo',
  //   '-usercon',
  //   '-norestart',
  //   '-strictportbind',
  //   '-ip 10.13.58.51',
  //   '-port 27015',
  //   '-tickrate 64',
  //   '-maxplayers_override 20',
  //   '+game_type 0',
  //   '+game_mode 0',
  //   '+map de_nuke',
  // ],
};
