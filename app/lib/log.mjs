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
  // Log everything
  // TODO: dynamic? load from envvar?
  loglevel.setLevel('trace', false);

  // Map loglevel to colors
  const colors = {
    TRACE: chalk.magenta.bold,
    DEBUG: chalk.cyan.bold,
    INFO: chalk.blue.bold,
    WARN: chalk.yellow.bold,
    ERROR: chalk.red.bold,
  };

  // Register our prefix
  prefix.reg(loglevel);
  // Setup the prefix
  prefix.apply(loglevel, {
    format(level, name, timestamp) {
      var string = '';
      string += `${chalk.gray(`${timestamp}`)} `;
      string += `${colors[level.toUpperCase()](level.slice(0, 2))} `;
      string += `${name.slice(0, 16).padEnd(16)}`;
      return string;
    },
  });

  // Return the logger for our module
  const log = loglevel.getLogger(module);
  return log;
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
