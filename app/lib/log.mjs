'use strict';

// External libs
import { default as chalk } from 'chalk';
import { default as loglevel } from 'loglevel';
import { default as prefix } from 'loglevel-plugin-prefix';

/**
 * Setup logging functions \
 * Available logging levels: \
 * log.trace('trace'); \
 * log.debug('debug'); \
 * log.log('log'); \
 * log.info('info'); \
 * log.warn('warn'); \
 * log.error('error');
 * @param {String} module - the module ident to report in logs
 * @returns {loglevel.getLogger} the logging interface
 */
export function setupLog(module = 'unknown') {
  loglevel.setLevel('trace', false);

  const colors = {
    TRACE: chalk.magenta.bold,
    DEBUG: chalk.cyan.bold,
    INFO: chalk.blue.bold,
    WARN: chalk.yellow.bold,
    ERROR: chalk.red.bold,
  };

  prefix.reg(loglevel);
  prefix.apply(loglevel, {
    format(level, name, timestamp) {
      var string = '';
      string += `${chalk.gray(`${timestamp}`)} `;
      string += `${colors[level.toUpperCase()](level.slice(0, 2))} `;
      string += `${name.slice(0, 16).padEnd(16)}`;
      return string;
    },
  });

  const _log = loglevel.getLogger(module);

  const log = {
    trace: () => {
      _log.trace(arguments);
    },
    debug: () => {
      _log.debug(arguments);
    },
    info: () => {
      _log.info(arguments);
    },
    warn: () => {
      _log.warn(arguments);
    },
    error: () => {
      _log.error(arguments);
    },
  };

  return _log;
}

/**
 * Generates a toISOString() timestamp
 * @returns {String} timestamp string
 */
export function isoTimestamp() {
  var now = new Date();
  now = now.toISOString();
  return now;
}
