'use strict';

export function timestamp() {
  var now = new Date();
  now = now.toISOString();
  return now;
}
