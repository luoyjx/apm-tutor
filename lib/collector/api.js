'use strict';

var path = require('path')
  , logger       = require(path.join(__dirname, '..', 'logger'))
      .child({component : 'collector_api'})
  , facts        = require(path.join(__dirname, 'facts.js'))
  , RemoteMethod = require(path.join(__dirname, 'remote-method.js'))
  ;

/*
 *
 * CONSTANTS
 *
 */

// just to make clear what's going on
var TO_MILLIS = 1e3;

var BACKOFFS = [
  {interval :  15, warn : false},
  {interval :  15, warn : false},
  {interval :  30, warn : false},
  {interval :  60, warn :  true},
  {interval : 120, warn : false},
  {interval : 300, warn : false}
];

var ERRORS = {
  INVALID_LICENSE : 'OneAPM::Agent::LicenseException',
  LIMIT_EXCEEDED  : 'OneAPM::Agent::InternalLimitExceeded',
  RESTART         : 'OneAPM::Agent::ForceRestartException',
  DISCONNECT      : 'OneAPM::Agent::ForceDisconnectException',
  MAINTENANCE     : 'OneAPM::Agent::MaintenanceError',
  RUNTIME         : 'RuntimeError'
};

var HTTP_REQUEST_TOO_LARGE      = 413
  , HTTP_UNSUPPORTED_MEDIA_TYPE = 415
  , HTTP_SERVER_INTERNAL        = 500
  , HTTP_LOL_COLLECTOR          = 503
  ;

function dumpErrors(errors, name) {
  var index = 1;

  errors.forEach(function cb_forEach(error) {
    logger.trace(error, "Error %s during %s:", index++, name);

    if (error.laterErrors) error.laterErrors.forEach(function cb_forEach(error) {
      logger.trace(error, "Error %s during %s:", index++, name);
    });
  });
}

function CollectorAPI(agent) {
  this._agent = agent;

  /* RemoteMethods can be reused and have little per-object state, so why not
   * save some GC time?
   */
  this._methods = {
    redirect  : new RemoteMethod('get_redirect_host',       agent.config),
    handshake : new RemoteMethod('connect',                 agent.config),
    settings  : new RemoteMethod('agent_settings',          agent.config),
    errors    : new RemoteMethod('error_data',              agent.config),
    metrics   : new RemoteMethod('metric_data',             agent.config),
    traces    : new RemoteMethod('transaction_sample_data', agent.config),
    sqls      : new RemoteMethod('sql_trace_data',          agent.config),
    queryData : new RemoteMethod('sql_trace_data',          agent.config),
    shutdown  : new RemoteMethod('shutdown',                agent.config),
    events    : new RemoteMethod('analytic_event_data',     agent.config),
    commands  : new RemoteMethod('get_agent_commands',      agent.config)
  };
}

CollectorAPI.prototype.connect = function connect(callback) {
  if (!callback) throw new TypeError("callback is required");

  var api      = this
    , attempts = 1
    , max      = BACKOFFS.length
    , errors   = []
    ;

  function retry(error, response, body) {
    if (error) errors.push(error);

    if (!error || attempts >= max) {
      dumpErrors(errors, 'connect');
      return callback(error, response, body);
    }

    // failing high-security mode compliance will cause a disconnect
    if (error.class === ERRORS.DISCONNECT) {
      logger.error("The OneAPM collector rejected this agent.");
      logger.error(error.message);
    }

    var backoff = BACKOFFS[attempts - 1];
    if (backoff.warn) {
      logger.warn(
        "No connection has been established to OneAPM after %s attempts.",
        attempts
      );
    }

    logger.debug(
      "Failed attempting to connect to OneAPM, waiting %ss to retry.",
      backoff.interval
    );

    attempts++;

    setTimeout(function again() { api._login(retry); }, backoff.interval * TO_MILLIS);
  }

  this._login(retry);
};

CollectorAPI.prototype._login = function _login(callback) {
  var methods = this._methods
    , agent   = this._agent
    ;

  methods.redirect.invoke(null, function cb_invoke(error, collector, body) {
    if (error ) {
      // Temporarily, if the server response an empty body or a 500 page, tell the user the license_key might not be valid.
      if( error.message.indexOf( 'No body found in response to' ) !== -1 || error.statusCode == HTTP_SERVER_INTERNAL ) {
        console.error( 'Server responses error, the provided license_key may be invalid!' );
      }
      return callback(error, collector, body);
    }
    if (!collector) {
      logger.error(
        "Requesting this account's collector from %s failed; trying default.",
        agent.config.host
      );
    }
    else {
      var parts = collector.split(':');
      if (parts.length > 2) {
        logger.error(
          "Requesting collector from %s returned bogus result '%s'; trying default.",
          agent.config.host,
          collector
        );
      }
      else {
        logger.debug(
          "Requesting this account's collector from %s returned %s; reconfiguring.",
          agent.config.host,
          collector
        );

        agent.config.host = parts[0];
        if (parts.length > 1) {
          agent.config.port = parts[1];
        }
      }
    }

    // The collector really likes arrays.
    // In fact, it kind of insists on them.
    var environment = [facts(agent)];

    methods.handshake.invoke(environment, function cb_invoke(error, config, body) {
      if (error) return callback(error, config, body);
      if (!config || !config.agent_run_id) {
        return callback(new Error("No agent run ID received from handshake."), config);
      }

      agent.state('connected');
      logger.info(
        "Connected to %s:%d with agent run ID %s.",
        agent.config.host,
        agent.config.port,
        config.agent_run_id
      );

      // pass configuration data from the API so automatic reconnect works
      agent.reconfigure(config);

      callback(null, config, body);
    });
  });
};

/**
 * Send current public agent settings to collector. This should always be
 * invoked after a successful connect response with server-side settings, but
 * will also be invoked on any other config changes.
 *
 * @param {Function} callback The continuation / error handler.
 */
CollectorAPI.prototype.reportSettings = function reportSettings(callback) {
  // The second argument to the callback is always empty data
  this._methods.settings.invoke([this._agent.config.publicSettings()], function cb_invoke(error, unused, body) {
    if (error) dumpErrors([error], 'agent_settings');

    if (callback) callback(error, body);
  });
};

/**
 * Send already-formatted error data by calling error_data. For
 * performance reasons, the API methods do no validation, but the
 * collector expects data in an exact format. It expects a JSON array
 * containing the following 2 elements:
 *
 * 1. The agent run ID.
 * 2. An array of one or more errors. See lib/error.js for details.
 *
 * @param {Array}    errors   The encoded errors list.
 * @param {Function} callback The continuation / error handler.
 */
CollectorAPI.prototype.errorData = function errorData(errors, callback) {
  if (!errors) throw new TypeError("must pass errors to send");
  if (!callback) throw new TypeError("callback is required");

  this._runLifecycle(this._methods.errors, errors, callback);
};

/**
 * Send already-formatted metric data by calling metric_data. For
 * performance reasons, the API methods do no validation, but the collector
 * expects data in an exact format format. It expects a JSON array containing
 * the following 4 elements:
 *
 * 1. The agent run ID.
 * 2. The time the metric data started being collected, in seconds since the
 *    epoch.
 * 3. The time the metric data finished being collected, in seconds since the
 *    epoch.
 * 4. An array of 1 or more metric arrays. See lib/metrics.js for details.
 *
 * @param {Array}    metrics  The encoded metrics list.
 * @param {Function} callback The continuation / error handler.
 */
CollectorAPI.prototype.metricData = function metricData(metrics, callback) {
  if (!metrics) throw new TypeError("must pass metrics to send");
  if (!callback) throw new TypeError("callback is required");

  this._runLifecycle(this._methods.metrics, metrics, callback);
};

CollectorAPI.prototype.analyticsEvents = function analyticsEvents(events, callback) {
  if (!events) throw new TypeError("must pass events to send");
  if (!callback) throw new TypeError("callback is required");
  this._runLifecycle(this._methods.events, events, callback);
};

/**
 * Send already-formatted slow trace data by calling
 * transaction_sample_data. For performance reasons, the API methods
 * do no validation, but the collector expects data in an exact format
 * format. It expects a JSON array containing the following 2 elements:
 *
 * 1. The agent run ID.
 * 2. The encoded slow trace data. This is the most complicated data
 *    format handled by the module, and documenting it is almost beyond the
 *    scope of comments. See lib/transaction/trace.js for details.
 *
 * @param {Array}    trace    The encoded trace data.
 * @param {Function} callback The continuation / error handler.
 */
CollectorAPI.prototype.transactionSampleData =
  function transactionSampleData(trace, callback) {
  if (!trace) throw new TypeError("must pass slow trace data to send");
  if (!callback) throw new TypeError("callback is required");

  this._runLifecycle(this._methods.traces, trace, callback);
};

/**
 * Send already-formatted slow SQL data by calling
 * sql_trace_data. For performance reasons, the API methods
 * do no validation, but the collector expects data in an exact format
 * format. It expects a JSON array containing the following 2 elements:
 *
 * 1. The agent run ID.
 * 2. The encoded slow SQL data. Node does not presently send this data,
 *    so there is currently no documentation in the repo on the format
 *    of this data.
 *
 * @param {Array}    sqls     The encoded slow SQL data.
 * @param {Function} callback The continuation / error handler.
 */
CollectorAPI.prototype.sqlTraceData = function sqlTraceData(sqls, callback) {
  if (!sqls) throw new TypeError("must pass slow SQL to send");
  if (!callback) throw new TypeError("callback is required");

  this._runLifecycle(this._methods.sqls, sqls, callback);
};


CollectorAPI.prototype.queryData = function customEvents(queries, callback) {
  if (!queries) throw new TypeError("must pass queries to send")
  if (!callback) throw new TypeError("callback is required")
  this._runLifecycle(this._methods.queryData, queries, callback)
}


/**
 * get commands to run
 * 
 * @param {Function} callback the continuation / error handler
 * @returns {undefined}
 */
CollectorAPI.prototype.commands = function (callback) {
    if (!callback) {
        throw new TypeError('callback is required');
    }

    var agent = this._agent;

    var commandsParams = [];
    // 
    // it is weird to pass in run_id as parameter again 
    // since it is already contained in the url
    commandsParams[0] = agent.config.run_id;
    
    this._runLifecycle(this._methods.commands, commandsParams, callback);
}

/**
 * Sends no data aside from the message itself. Clears the run ID, which
 * effectively disconnects the agent from the collector.
 *
 * @param Function callback Runs after the run ID has been cleared.
 */
CollectorAPI.prototype.shutdown = function shutdown(callback) {
  if (!callback) throw new TypeError("callback is required");

  var agent = this._agent;
  this._methods.shutdown.invoke(null, function closed(error, returned, body) {
    if (error) {
      dumpErrors([error], 'shutdown');
    }
    else {
      agent.state('disconnected');
      logger.info(
        "Disconnected from OneAPM; clearing run ID %s.",
        agent.config.run_id
      );
      agent.config.run_id = undefined;
    }

    callback(error, returned, body);
  });
};

CollectorAPI.prototype._restart = function _restart(callback) {
  var api = this;
  this.shutdown(function reconnect() { api.connect(callback); });
};

CollectorAPI.prototype._runLifecycle = function _runLifecycle(method, body, callback) {
  if (!this.isConnected()) {
    logger.warn("Not connected to OneAPM. Not calling.", method.name);
    return callback(new Error("Not connected to collector.", null, null));
  }

  var api = this;
  function standardHandler(error, returned, json) {
    if (!error) return callback(error, returned, json);

    dumpErrors([error], method.name);

    if (error.statusCode === HTTP_REQUEST_TOO_LARGE) {
      logger.error(
        error,
        "This call of %s sent OneAPM too much data; discarding (%s):",
        method.name,
        HTTP_REQUEST_TOO_LARGE
      );
      return callback(null, returned, json);
    }
    else if (error.statusCode === HTTP_UNSUPPORTED_MEDIA_TYPE) {
      logger.error(
        error,
        "The OneAPM collector couldn't deserialize data; discarding for %s (%s):",
        method.name,
        HTTP_UNSUPPORTED_MEDIA_TYPE
      );
      return callback(null, returned, json);
    }
    else if (error.statusCode === HTTP_LOL_COLLECTOR) {
      logger.debug(
        error,
        "OneAPM is experiencing a spot of bother; please hold on (%s):",
        HTTP_LOL_COLLECTOR
      );
      return callback(error, returned, json);
    }
    else if (error.statusCode === HTTP_SERVER_INTERNAL) {
      logger.error(
        error,
        "OneAPM's servers encountered a severe internal error on %s (%s):",
        method.name,
        HTTP_SERVER_INTERNAL
      );
      return callback(error, returned, json);
    }
    else if (error.class === ERRORS.INVALID_LICENSE) {
      logger.error(
        error,
        "Your OneAPM license key appears to be invalid. Please double-check it:"
      );

      return callback(error, returned, json);
    }
    else if (error.class === ERRORS.LIMIT_EXCEEDED) {
      logger.error(
        error,
        "OneAPM ran into a weird problem with %s. Let support@oneapm.com know:",
        method.name
      );
      return callback(null, returned, json);
    }
    else if (error.class === ERRORS.RESTART) {
      logger.info(
        error,
        "The OneAPM collector requested a connection restart on %s:",
        method.name
      );

      return api._restart(function cb__restart() { method.invoke(body, standardHandler); });
    }
    else if (error.class === ERRORS.DISCONNECT) {
      logger.error(error, "The OneAPM collector is shutting down this agent:");

      return api._agent.stop(function cb_stop() { callback(error, returned, json); });
    }
    else if (error.class === ERRORS.MAINTENANCE) {
      logger.info(
        error,
        "The OneAPM server for your account is currently undergoing maintenance. " +
          "Data will be held until it can be submitted (failed on %s):",
        method.name
      );
      return callback(error, returned, json);
    }
    else if (error.class === ERRORS.RUNTIME) {
      logger.warn(
        error,
        "Calling %s on OneAPM failed due to a runtime error. " +
          "Data will be held until it can be submitted:",
        method.name
      );
      return callback(error, returned, json);
    }
    else {
      logger.error(
        error,
        "Calling %s on OneAPM failed unexpectedly. " +
          "Data will be held until it can be submitted:",
        method.name
      );
      return callback(error, returned, json);
    }
  }

  method.invoke(body, standardHandler);
};

CollectorAPI.prototype.isConnected = function isConnected() {
  return !!this._agent.config.run_id;
};

module.exports = CollectorAPI;
