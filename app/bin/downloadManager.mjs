'use strict';

// Our libraries
import { timestamp } from '../lib/timestamp.mjs';
import { parseBool } from '../lib/parseBool.mjs';
import { lockFile, unlockFile } from '../lib/lockfile.mjs';
import { setupIpc } from '../lib/ipc.mjs';

// exec initial game downloads

// listen for "update pls" messages
