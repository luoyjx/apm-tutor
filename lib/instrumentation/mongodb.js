"use strict";

var path = require('path'),
  ParsedStatement = require(path.join(__dirname, '..', 'db', 'nosql-statement')),
  shimmer = require(path.join(__dirname, '..', 'shimmer')),
  stackUtil = require(path.join(__dirname, '..', 'util', 'stack.js')),
  urltils = require(path.join(__dirname, '..', 'util', 'urltils.js')),
  logger = require(path.join(__dirname, '..',
    'logger')).child({
    component: 'mongodb'
  }),
  MONGODB = require(path.join(__dirname, '..', 'metrics', 'names')).MONGODB;

var INSTRUMENTED_OPERATIONS = [
  'find',
  'findOne',
  'insert',
  'insertOne',
  'remove',
  'removeOne',
  'save',
  'update',
  'updateOne',
  'distinct',
  'count',
  'findAndModify',
  'findAndRemove',
  'createIndex',
  'ensureIndex',
  'dropIndex',
  'dropAllIndexes',
  'reIndex'
];

/**
 * Everything uses nextObject, whether you're streaming or using callbacks.
 *
 * @param {TraceSegment} segment The current segment, to be closed when done.
 * @param {Tracer}       tracer  The current transaction trcer.
 *
 * @returns {Function} A callback that further wraps the callback called by the
 *                     wrapped nextObject method, so we can tell when the cursor
 *                     is exhausted.
 */
function wrapNextObject(tracer) {
  return function cls_wrapNextObject(nextObject) {
    return function wrappedNextObject() {
      if (!tracer.getTransaction()) return nextObject.apply(this, arguments);

      var args = tracer.slice(arguments),
        last = args.length - 1,
        callback = args[last],
        cursor = this;

      if (typeof callback === 'function' && cursor.collection) {
        args[last] = tracer.callbackProxy(function cb_callbackProxy(err, object) {
          var collection = cursor.collection.collectionName || 'unknown',
            remaining = cursor.items.length,
            total = cursor.totalNumberOfRecords,
            limit = cursor.limitValue === -1 ? 1 : cursor.limitValue,
            returned = callback.apply(this, arguments),
            segment = tracer.getSegment();

          if (remaining === 0 && limit === total) {
            segment.end();
            logger.trace("MongoDB query trace segment ended for %s: end of batch.",
              collection);
          } else if (!object) {
            segment.end();
            logger.trace("MongoDB query trace segment ended for %s: nothing to pull.",
              collection);
          }

          /* each time the cursor is called, update the prospective end time
           * for the MongoDB cursor
           */
          segment.touch();

          return returned;
        });
      }

      return nextObject.apply(this, args);
    };
  };
}

function addMongoStatement(tracer, collection, operation) {
  var statement = new ParsedStatement(MONGODB.PREFIX, operation, collection),
    recorder = statement.recordMetrics.bind(statement),
    name = MONGODB.STATEMENT + collection + '/' + operation;

  return tracer.addSegment(name, recorder);
}

module.exports = function initialize(agent, mongodb) {
  if (!(mongodb && mongodb.Collection && mongodb.Collection.prototype)) return;

  var tracer = agent.tracer;

  if (mongodb && mongodb.Cursor && mongodb.Cursor.prototype) {
    shimmer.wrapMethod(mongodb.Cursor.prototype,
      'mongodb.Cursor.prototype', 'nextObject', wrapNextObject(tracer));
  }

  INSTRUMENTED_OPERATIONS.forEach(function cb_forEach(operation) {
    shimmer.wrapMethod(mongodb.Collection.prototype,
      'mongodb.Collection.prototype', operation,
      function cls_MONGO_OPERATION(command) {
        return tracer.segmentProxy(function cb_segmentProxy() {
          var collection = this.collectionName || 'unknown',
            args = tracer.slice(arguments),
            terms = typeof args[0] === 'function' ? undefined : args[0];

          if (args.length < 1) {
            logger.trace("Not tracing MongoDB %s.%s(); no command parameters.",
              collection, operation);

            return command.apply(this, arguments);
          } else if (!tracer.getTransaction()) {
            logger.trace("Not tracing MongoDB %s.%s(); no OneAPM transaction.",
              collection, operation);
            if (terms) logger.trace({
              terms: terms
            }, "With terms:");

            return command.apply(this, arguments);
          }

          logger.trace("Tracing MongoDB %s.%s(%j).", collection, operation, terms);

          /* Don't add segments when MongoDB is calling back into itself.
           * Mildly heuristic: MongoDB operations that self-call do so on the
           * same tick, so if a MongoDB operation has already happened this
           * tick (according to the tracer), then it's a self-call.
           */
          if (!tracer.isCurrentSegmentType(MONGODB.PREFIX)) {
            tracer.setCurrentSegmentType(MONGODB.PREFIX);
            var transaction = tracer.getTransaction(),
              segment = addMongoStatement(tracer, collection, operation);

            if (typeof terms === 'object') {
              urltils.copyParameters(agent.config, terms, segment.parameters);
            }

            // capture configuration information if available
            if (this.db && this.db.serverConfig) {
              segment.host = this.db.serverConfig.host;
              segment.port = this.db.serverConfig.port;
            }
            // Add backtrace to segment.
            var stack = (new Error()).stack;
            segment.parameters.backtrace = stackUtil.formatStack( stack );

            var callback = args.pop();
            if (typeof callback !== 'function') {
              args.push(callback);
              if (operation !== 'find'&&operation !== 'count') {
                args.push(tracer.callbackProxy(function cb_callbackProxy() {
                  segment.end();
                  logger.trace("Tracing MongoDB %s.%s(%j) ended for transaction %s.",
                    collection, operation, terms, transaction.id);
                }));
              }
            } else {
              if (operation === 'find') {
                args.push(tracer.callbackProxy(callback));
              } else {
                args.push(tracer.callbackProxy(function cb_callbackProxy() {
                  var returned = callback.apply(this, arguments);

                  segment.end();
                  logger.trace("Tracing MongoDB %s.%s(%j) ended for transaction %s.",
                    collection, operation, terms, transaction.id);

                  return returned;
                }));
              }
            }
          }

          return command.apply(this, args);
        });
      });
  });
};
