'use strict';

export function parseBool(string) {
  if (string) {
    switch (string.toLowerCase().trim()) {
      case 'true':
      case 'yes':
      case '1':
        return true;

      case 'false':
      case 'no':
      case '0':
      case '':
      case null:
        return false;

      default:
        return Boolean(string);
    }
  } else {
    return false;
  }
}
