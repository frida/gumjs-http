import { Agent, globalAgent } from './lib/_http_agent.js';
import { ClientRequest } from './lib/_http_client.js';
import { methods as rawMethods } from './lib/_http_common.js';
import { IncomingMessage } from './lib/_http_incoming.js';
import { OutgoingMessage } from './lib/_http_outgoing.js';
import {
  Server,
  ServerResponse,
  STATUS_CODES,
  _connectionListener,
} from './lib/_http_server.js';

const METHODS = rawMethods.slice().sort();

export default {
  IncomingMessage,
  OutgoingMessage,
  METHODS,
  Agent,
  globalAgent,
  Server,
  ServerResponse,
  STATUS_CODES,
  _connectionListener,
  createServer,
  ClientRequest,
  request,
  get,
};

export {
  IncomingMessage,
  OutgoingMessage,
  METHODS,
  Agent,
  globalAgent,
  Server,
  ServerResponse,
  STATUS_CODES,
  _connectionListener,
  createServer,
  ClientRequest,
  request,
  get,
};

function createServer(requestListener) {
  return new Server(requestListener);
}

function request(options, cb) {
  return new ClientRequest(options, cb);
}

function get(options, cb) {
  const req = request(options, cb);
  req.end();
  return req;
}
