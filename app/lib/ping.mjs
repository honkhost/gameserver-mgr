'use strict';

// External libs
// We import qlobber-fsq here so we can use it as a datatype in the function sig below
import { default as qfsq } from 'qlobber-fsq';
import { default as clog } from 'ee-log';

const debug = process.env.DEBUG || true;

export function setPingReply(ipc = qfsq.QlobberFSQ, ident = '', status = '') {
  ipc.unsubscribe(`${ident}.ping`);
  ipc.unsubscribe(`_broadcast.ping`);
  ipc.subscribe(`${ident}.ping`, (data) => {
    const pingRequest = JSON.parse(data);
    if (debug) clog.debug('Ping request received:', pingRequest);
    const pingReply = {
      requestId: pingRequest.requestId,
      ident: ident,
      pid: process.pid,
      status: status,
    };
    if (debug) clog.debug(`Sending reply to: ${pingRequest.replyTo}`, pingReply);
    ipc.publish(pingRequest.replyTo, JSON.stringify(pingReply));
  });

  ipc.subscribe(`_broadcast.ping`, (data) => {
    const pingRequest = JSON.parse(data);
    if (debug) clog.debug('Ping request received:', pingRequest);
    const pingReply = {
      requestId: pingRequest.requestId,
      ident: ident,
      pid: process.pid,
      status: status,
    };
    if (debug) clog.debug(`Sending reply to: ${pingRequest.replyTo}`, pingReply);
    ipc.publish(pingRequest.replyTo, JSON.stringify(pingReply));
  });
}
