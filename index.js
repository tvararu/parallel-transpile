// Generated by CoffeeScript 1.9.3
var Bucket, EventEmitter, Queue, child_process, chokidar, cluster, endsWith, error, fs, os, utils,
  bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; },
  extend = function(child, parent) { for (var key in parent) { if (hasProp.call(parent, key)) child[key] = parent[key]; } function ctor() { this.constructor = child; } ctor.prototype = parent.prototype; child.prototype = new ctor(); child.__super__ = parent.prototype; return child; },
  hasProp = {}.hasOwnProperty;

fs = require('fs');

cluster = require('cluster');

utils = require('./utils');

cluster.setupMaster({
  exec: __dirname + "/worker",
  args: []
});

if (!cluster.isMaster) {
  require('./worker');
  return;
}

EventEmitter = require('events');

chokidar = require('chokidar');

os = require('os');

child_process = require('child_process');

error = function(code, message) {
  var err;
  err = new Error(message);
  err.code = code;
  return err;
};

endsWith = function(str, end) {
  return str.substr(str.length - end.length) === end;
};

Bucket = (function(superClass) {
  extend(Bucket, superClass);

  function Bucket(options1) {
    var ref;
    this.options = options1 != null ? options1 : {};
    this.receive = bind(this.receive, this);
    this.capacity = (ref = this.options.bucketCapacity) != null ? ref : 3;
    this.queue = [];
    this.child = cluster.fork();
    this.id = this.child.id;
    this.child.send({
      init: this.options
    });
    this.child.on('message', this.receive);
  }

  Bucket.prototype.receive = function(message) {
    var task;
    task = this.queue.shift();
    this.perform();
    if (message === 'complete') {
      return this.emit('complete', this, null, task);
    } else {
      return this.emit('complete', this, message, task);
    }
  };

  Bucket.prototype.add = function(task) {
    this.queue.push(task);
    if (this.queue.length === 1) {
      return this.perform();
    }
  };

  Bucket.prototype.perform = function() {
    var task;
    task = this.queue[0];
    if (!task) {
      return;
    }
    return this.child.send(task);
  };

  Bucket.prototype.destroy = function() {
    return this.child.kill();
  };

  return Bucket;

})(EventEmitter);

Queue = (function(superClass) {
  extend(Queue, superClass);

  function Queue(options1, oneshot) {
    this.options = options1;
    this.oneshot = oneshot;
    this.remove = bind(this.remove, this);
    this.add = bind(this.add, this);
    this.complete = bind(this.complete, this);
    this.destroy = bind(this.destroy, this);
    this.paused = true;
    this.queue = [];
    this.inProgress = [];
  }

  Queue.prototype.destroy = function() {
    var bucket, j, len, ref, results;
    if (!this.buckets) {
      return;
    }
    process.removeListener('exit', this.destroy);
    ref = this.buckets;
    results = [];
    for (j = 0, len = ref.length; j < len; j++) {
      bucket = ref[j];
      results.push(bucket.destroy());
    }
    return results;
  };

  Queue.prototype.complete = function(bucket, err, task) {
    var i, path;
    path = task.path;
    if (err) {
      console.log("[" + bucket.id + "] Failed: " + path);
    } else {
      console.log("[" + bucket.id + "] Processed: " + path);
    }
    i = this.inProgress.indexOf(path);
    if (i === -1) {
      throw new Error("This shouldn't be able to happen");
    }
    this.inProgress.splice(i, 1);
    this.processNext();
    if (this.inProgress.length === 0) {
      this.emit('empty');
      if (this.oneshot) {
        this.destroy();
      }
    }
  };

  Queue.prototype.run = function() {
    var bucket, i, j, ref;
    this.buckets = [];
    for (i = j = 0, ref = this.options.parallel; 0 <= ref ? j < ref : j > ref; i = 0 <= ref ? ++j : --j) {
      bucket = new Bucket(this.options);
      bucket.on('complete', this.complete);
      this.buckets.push(bucket);
    }
    process.on('exit', this.destroy);
    delete this.paused;
    this.processNext();
    if (!(this.inProgress.length > 0)) {
      return this.emit('empty');
    }
  };

  Queue.prototype.rule = function(path) {
    var j, len, ref, rule;
    ref = this.options.rules;
    for (j = 0, len = ref.length; j < len; j++) {
      rule = ref[j];
      if (endsWith(path, rule.inExt)) {
        return rule;
      }
    }
    return null;
  };

  Queue.prototype.add = function(path) {
    if (this.queue.indexOf(path) === -1 && this.rule(path)) {
      this.queue.push(path);
      return this.processNext();
    }
  };

  Queue.prototype.remove = function(path) {
    var i;
    i = this.queue.indexOf(path);
    if (i !== -1) {
      return this.queue.splice(i, 1);
    }
  };

  Queue.prototype.processNext = function() {
    var availablePath, bestBucket, bestBucketScore, bucket, i, j, k, len, len1, path, ref, ref1, score;
    if (this.paused) {
      return;
    }
    if (!this.queue.length) {
      return;
    }
    bestBucket = null;
    bestBucketScore = 0;
    ref = this.buckets;
    for (j = 0, len = ref.length; j < len; j++) {
      bucket = ref[j];
      if ((score = bucket.capacity - bucket.queue.length) > 0) {
        if (!bestBucket || score > bestBucketScore) {
          bestBucket = bucket;
        }
      }
    }
    if (!bestBucket) {
      return;
    }
    ref1 = this.queue;
    for (i = k = 0, len1 = ref1.length; k < len1; i = ++k) {
      path = ref1[i];
      if (!(this.inProgress.indexOf(path) === -1)) {
        continue;
      }
      availablePath = path;
      this.queue.splice(i, 1);
      break;
    }
    if (!availablePath) {
      return;
    }
    this.inProgress.push(availablePath);
    bestBucket.add({
      path: availablePath,
      rule: this.rule(availablePath)
    });
    return this.processNext();
  };

  return Queue;

})(EventEmitter);

module.exports = function(options, callback) {
  var inExt, j, len, loaders, matches, outExt, queue, recurse, ref, ref1, ref2, type, watchQueue, watcher;
  if (!fs.existsSync(options.source) || !fs.statSync(options.source).isDirectory()) {
    return callback(error(2, "Input must be a directory"));
  }
  if (!options.output) {
    return callback(error(1, "No output directory specified"));
  }
  if (!fs.existsSync(options.output) || !fs.statSync(options.output).isDirectory()) {
    return callback(error(3, "Output option must be a directory"));
  }
  if (options.rules == null) {
    options.rules = [];
  }
  if (options.type && !Array.isArray(options.type)) {
    options.type = [options.type];
  }
  ref1 = (ref = options.type) != null ? ref : [];
  for (j = 0, len = ref1.length; j < len; j++) {
    type = ref1[j];
    matches = type.match(/^([^:]*)(?::([^:]*)(?::([^:]*))?)?$/);
    if (!matches) {
      return callback(error(1, "Invalid type specification: '" + type + "'"));
    }
    ref2 = matches.slice(1), inExt = ref2[0], loaders = ref2[1], outExt = ref2[2];
    if (loaders == null) {
      loaders = "";
    }
    if (outExt == null) {
      outExt = inExt;
    }
    options.rules.push({
      inExt: inExt,
      loaders: loaders.split(",").filter(function(a) {
        return a.length > 0;
      }),
      outExt: outExt
    });
  }
  if (options.parallel != null) {
    options.parallel = parseInt(options.parallel, 10);
    if (!isFinite(options.parallel) || options.parallel < 0) {
      delete options.parallel;
      console.error("Did not understand parallel option value, discarding it.");
    }
  }
  options.parallel || (options.parallel = os.cpus().length);
  if (options.watch) {
    watchQueue = new Queue(options);
    watcher = chokidar.watch(options.source);
    watcher.on('ready', function() {
      watcher.on('add', watchQueue.add);
      watcher.on('change', watchQueue.add);
      return watcher.on('unlink', watchQueue.remove);
    });
  }
  queue = new Queue(options, true);
  recurse = function(path) {
    var aRule, file, filePath, files, k, l, len1, len2, outPath, ref3, relativePath, rule, shouldAdd, stat, stat2;
    files = fs.readdirSync(path);
    for (k = 0, len1 = files.length; k < len1; k++) {
      file = files[k];
      if (!(!file.match(/^\.+$/))) {
        continue;
      }
      filePath = path + "/" + file;
      stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        recurse(filePath);
      } else if (stat.isFile()) {
        shouldAdd = true;
        if (options.newer) {
          rule = null;
          ref3 = options.rules;
          for (l = 0, len2 = ref3.length; l < len2; l++) {
            aRule = ref3[l];
            if (!(endsWith(filePath, aRule.inExt))) {
              continue;
            }
            rule = aRule;
            break;
          }
          if (rule) {
            inExt = rule.inExt, outExt = rule.outExt;
            relativePath = filePath.substr(options.source.length);
            outPath = options.output + "/" + (utils.swapExtension(relativePath, inExt, outExt));
            try {
              stat2 = fs.statSync(outPath);
            } catch (_error) {}
            if (stat2 && stat2.mtime > stat.mtime) {
              shouldAdd = false;
            }
          }
        }
        if (shouldAdd) {
          queue.add(filePath);
        }
      }
    }
  };
  recurse(options.source);
  queue.on('empty', function() {
    console.log("INITIAL BUILD COMPLETE");
    if (typeof options.initialBuildComplete === "function") {
      options.initialBuildComplete();
    }
    return watchQueue != null ? watchQueue.run() : void 0;
  });
  return queue.run();
};

//# sourceMappingURL=index.js.map
