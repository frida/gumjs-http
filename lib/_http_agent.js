import EventEmitter from 'events';
import net from 'net';
import process from 'process';
import util from 'util';

// New Agent code.

// The largest departure from the previous implementation is that
// an Agent instance holds connections for a variable number of host:ports.
// Surprisingly, this is still API compatible as far as third parties are
// concerned. The only code that really notices the difference is the
// request object.

// Another departure is that all code related to HTTP parsing is in
// ClientRequest.onSocket(). The Agent is now *strictly*
// concerned with managing a connection pool.

export function Agent(options) {
  if (!(this instanceof Agent))
    return new Agent(options);

  EventEmitter.call(this);

  var self = this;

  self.defaultPort = 80;
  self.protocol = 'http:';

  self.options = util._extend({}, options);

  // don't confuse net and make it think that we're connecting to a pipe
  self.options.path = null;
  self.requests = {};
  self.sockets = {};
  self.freeSockets = {};
  self.keepAliveMsecs = self.options.keepAliveMsecs || 1000;
  self.keepAlive = self.options.keepAlive || false;
  self.maxSockets = self.options.maxSockets || Agent.defaultMaxSockets;
  self.maxFreeSockets = self.options.maxFreeSockets || 256;

  self.on('free', function(socket, options) {
    var name = self.getName(options);

    if (socket.writable &&
        self.requests[name] && self.requests[name].length) {
      self.requests[name].shift().onSocket(socket);
      if (self.requests[name].length === 0) {
        // don't leak
        delete self.requests[name];
      }
    } else {
      // If there are no pending requests, then put it in
      // the freeSockets pool, but only if we're allowed to do so.
      var req = socket._httpMessage;
      if (req &&
          req.shouldKeepAlive &&
          socket.writable &&
          self.keepAlive) {
        var freeSockets = self.freeSockets[name];
        var freeLen = freeSockets ? freeSockets.length : 0;
        var count = freeLen;
        if (self.sockets[name])
          count += self.sockets[name].length;

        if (count > self.maxSockets || freeLen >= self.maxFreeSockets) {
          socket.destroy();
        } else {
          freeSockets = freeSockets || [];
          self.freeSockets[name] = freeSockets;
          socket.setKeepAlive(true, self.keepAliveMsecs);
          socket.unref();
          socket._httpMessage = null;
          self.removeSocket(socket, options);
          freeSockets.push(socket);
        }
      } else {
        socket.destroy();
      }
    }
  });
}

util.inherits(Agent, EventEmitter);

Agent.defaultMaxSockets = Infinity;

Agent.prototype.createConnection = net.createConnection;

// Get the key for a given set of request options
Agent.prototype.getName = function(options) {
  var name = options.host || 'localhost';

  name += ':';
  if (options.port)
    name += options.port;

  name += ':';
  if (options.localAddress)
    name += options.localAddress;

  // Pacify parallel/test-http-agent-getname by only appending
  // the ':' when options.family is set.
  if (options.family === 4 || options.family === 6)
    name += ':' + options.family;

  return name;
};

Agent.prototype.addRequest = function(req, options) {
  // Legacy API: addRequest(req, host, port, localAddress)
  if (typeof options === 'string') {
    options = {
      host: options,
      port: arguments[2],
      localAddress: arguments[3]
    };
  }

  options = util._extend({}, options);
  options = util._extend(options, this.options);

  if (!options.servername) {
    options.servername = options.host;
    const hostHeader = req.getHeader('host');
    if (hostHeader) {
      options.servername = hostHeader.replace(/:.*$/, '');
    }
  }

  var name = this.getName(options);
  if (!this.sockets[name]) {
    this.sockets[name] = [];
  }

  var freeLen = this.freeSockets[name] ? this.freeSockets[name].length : 0;
  var sockLen = freeLen + this.sockets[name].length;

  if (freeLen) {
    // we have a free socket, so use that.
    var socket = this.freeSockets[name].shift();

    // don't leak
    if (!this.freeSockets[name].length)
      delete this.freeSockets[name];

    socket.ref();
    req.onSocket(socket);
    this.sockets[name].push(socket);
  } else if (sockLen < this.maxSockets) {
    // If we are under maxSockets create a new one.
    this.createSocket(req, options, function(err, newSocket) {
      if (err) {
        process.nextTick(function() {
          req.emit('error', err);
        });
        return;
      }
      req.onSocket(newSocket);
    });
  } else {
    // We are over limit so we'll add it to the queue.
    if (!this.requests[name]) {
      this.requests[name] = [];
    }
    this.requests[name].push(req);
  }
};

Agent.prototype.createSocket = function(req, options, cb) {
  var self = this;
  options = util._extend({}, options);
  options = util._extend(options, self.options);

  if (!options.servername) {
    options.servername = options.host;
    const hostHeader = req.getHeader('host');
    if (hostHeader) {
      options.servername = hostHeader.replace(/:.*$/, '');
    }
  }

  var name = self.getName(options);
  options._agentKey = name;

  options.encoding = null;
  var called = false;
  const newSocket = self.createConnection(options, oncreate);
  if (newSocket)
    oncreate(null, newSocket);
  function oncreate(err, s) {
    if (called)
      return;
    called = true;
    if (err)
      return cb(err);
    if (!self.sockets[name]) {
      self.sockets[name] = [];
    }
    self.sockets[name].push(s);

    function onFree() {
      self.emit('free', s, options);
    }
    s.on('free', onFree);

    function onClose(err) {
      // This is the only place where sockets get removed from the Agent.
      // If you want to remove a socket from the pool, just close it.
      // All socket errors end in a close event anyway.
      self.removeSocket(s, options);
    }
    s.on('close', onClose);

    function onRemove() {
      // We need this function for cases like HTTP 'upgrade'
      // (defined by WebSockets) where we need to remove a socket from the
      // pool because it'll be locked up indefinitely
      self.removeSocket(s, options);
      s.removeListener('close', onClose);
      s.removeListener('free', onFree);
      s.removeListener('agentRemove', onRemove);
    }
    s.on('agentRemove', onRemove);
    cb(null, s);
  }
};

Agent.prototype.removeSocket = function(s, options) {
  var name = this.getName(options);
  var sets = [this.sockets];

  // If the socket was destroyed, remove it from the free buffers too.
  if (!s.writable)
    sets.push(this.freeSockets);

  for (var sk = 0; sk < sets.length; sk++) {
    var sockets = sets[sk];

    if (sockets[name]) {
      var index = sockets[name].indexOf(s);
      if (index !== -1) {
        sockets[name].splice(index, 1);
        // Don't leak
        if (sockets[name].length === 0)
          delete sockets[name];
      }
    }
  }

  if (this.requests[name] && this.requests[name].length) {
    var req = this.requests[name][0];
    // If we have pending requests and a socket gets closed make a new one
    this.createSocket(req, options, function(err, newSocket) {
      if (err) {
        process.nextTick(function() {
          req.emit('error', err);
        });
        return;
      }
      newSocket.emit('free');
    });
  }
};

Agent.prototype.destroy = function() {
  var sets = [this.freeSockets, this.sockets];
  for (var s = 0; s < sets.length; s++) {
    var set = sets[s];
    var keys = Object.keys(set);
    for (var v = 0; v < keys.length; v++) {
      var setName = set[keys[v]];
      for (var n = 0; n < setName.length; n++) {
        setName[n].destroy();
      }
    }
  }
};

export const globalAgent = new Agent();
