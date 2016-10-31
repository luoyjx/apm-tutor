'use strict';

var path = require('path');
var NAMES = require(path.join(__dirname, 'metrics', 'names'));
var Timer = require(path.join(__dirname, 'timer'));


var samplers = [];

/**
 * 采样器
 *
 * 以一定周期执行采样逻辑
 * 
 * @param {[type]} sampler  [description]
 * @param {[type]} interval [description]
 */
function Sampler(sampler, interval) {
  this.id = setInterval(sampler, interval);
  // timer.unref only in 0.9+
  // unrefed Timeout/Interval will not prevent the program from exiting
  
  // unref方法用于取消当前id的定时器
  if (this.id.unref) {
    this.id.unref();
  }
}

/**
 * 停止采样
 * @return {[type]} [description]
 */
Sampler.prototype.stop = function stop() {
  clearInterval(this.id);
};

function recordQueueTime(agent, timer) {

  timer.end();
  agent.metrics.measureMilliseconds(NAMES.EVENTS.WAIT, null, timer.getDurationInMillis());
}

/**
 * 对cpu进行采样
 * @since 1.2.2
 */
function sampleCPU(agent) {
  var pidusage = require('pidusage-fork');
  return function CPUSampler() {
    //result is {cpu:percentage ...}
    pidusage.stat(process.pid, function (err, result) {
      if (err) {

      } else {
        var stats = agent.metrics.getOrCreateMetric(NAMES.CPU.USERUtilization);
        stats.recordValue(result.cpu / 100);
      }
    });
  };
}

/**
 * 对内存进行采样
 * @param  {[type]} agent [description]
 * @return {[type]}       [description]
 */
function sampleMemory(agent) {
  return function memorySampler() {
    var mem = process.memoryUsage();
    agent.metrics.measureBytes(NAMES.MEMORY.PHYSICAL, mem.rss);
  };
}

function checkEvents(agent) {
  return function eventSampler() {
    var timer = new Timer();
    timer.begin();
    setTimeout(recordQueueTime.bind(null, agent, timer), 0);
  };
}

var sampler = {
  state: 'stopped',

  sampleMemory: sampleMemory,
  checkEvents: checkEvents,
  sampleCPU: sampleCPU,

  start: function start(agent) {
    samplers.push(new Sampler(sampleCPU(agent), 5e3)); // 每5秒采样一次
    samplers.push(new Sampler(sampleMemory(agent), 5e3)); // 每5秒采样一次
    samplers.push(new Sampler(checkEvents(agent), 15e3)); // 每15秒采样一次
    sampler.state = 'running';
  },

  stop: function stop() {
    samplers.forEach(function cb_forEach(sampler) {
      sampler.stop();
    });
    samplers = [];
    sampler.state = 'stopped';
  }
};

module.exports = sampler;
