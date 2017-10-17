const DataStore = require('nedb');
const path = require('path');
const fs = require('fs');
const uuidv4 = require('uuid/v4');
const { EventEmitter } = require('events');
const { resolveAsync } = require('./resolve-async');

class Store extends EventEmitter {
  constructor () {
    super();
    resolveAsync(this);
  }

  path (...args) {
    return path.join(this.persistDir, ...args);
  }

  *setup (persistDir) {
    this.persistDir = persistDir;
    setInterval(() => this.sanitize(), 5000);

    yield cb => fs.mkdir(this.persistDir, err => cb());
    yield cb => fs.mkdir(this.path('jobs'), err => cb());

    this.topic = new DataStore({
      filename: this.path('topic.db'),
      autoload: true,
    });
    this.topic.persistence.setAutocompactionInterval(24 * 3600 * 1000);

    this.queues = {};
    this.idLists = {};
    this.jobStatus = {};

    yield this.scanJobsDir();
    this.ready = true;
    this.emit('topic-update');
  }
  
  *scanJobsDir () {
    const [files] = yield cb => fs.readdir(this.path('jobs'), cb);
    const expire = Date.now() - 12 * 3600 * 1000;
    for (const file of files) {
      try {
        if (/^unfinished/.test(file)) {
          const [content] = yield cb => fs.readFile(this.path('jobs', file), cb);
          const { topic, priority, payload, payloadType = '', noRetry = false, id = '', createTime = 0 } = JSON.parse(content);
          yield this.appendJob(topic, priority, payload, payloadType, noRetry, id, createTime);
          console.log(id);
        } else {
          const [stat] = yield cb => fs.stat(this.path('jobs', file), cb);
          if (stat.ctime.getTime() < expire) {
            fs.unlink(this.path('jobs', file), err => null);
          }
        }
      } catch (err) {
        console.error(err.stack);
      }
    }
  }

  queue (name, priority) {
    const key = `${name}#${priority}`;
    let ret = this.queues[key];
    if (!ret) {
      this.queues[key] = ret = new Queue();
    }
    return ret;
  }

  idList (name) {
    let ret = this.idLists[name];
    if (!ret) {
      this.idLists[name] = ret = [];
    }
    return ret;
  }

  *allTopics () {
    const [docs] = yield cb => this.topic.find().exec(cb);
    return docs;
  }

  *getTopic (id) {
    const [doc] = yield cb => this.topic.findOne({ _id: id }).exec(cb);
    return doc;
  }

  *saveTopic (topic) {
    yield cb => this.topic.update({ _id: topic._id }, topic, { upsert: true }, cb);
    this.emit('topic-update');
  }

  *removeTopic (topic) {
    for (let i = 0; i < 3; i++) {
      this.queue(topic, i).reset();
    }
    yield cb => this.topic.remove({ _id: topic }, cb);
    return true;
  }

  *allCounters () {}

  *appendJob (topic, priority, payload, payloadType = '', noRetry = false, jobId = '', createTime = 0) {
    if (priority !== 0 && priority !== 1 && priority !== 2) {
      throw new Error('Can only accept priorities of 0, 1, 2');
    }
    if (!jobId) {
      jobId = uuidv4();
    }
    if (!createTime) {
      createTime = Date.now();
    }
    const jobStatus = this.jobStatus[jobId] = {
      jobId, topic, priority,
      status: 'pending',
      createTime: new Date(createTime),
      worker: '',
      retried: 0,
      expire: Date.now() + 7 * 24 * 3600 * 1000,
      queue: this.queue(topic, priority),
    };
    jobStatus.queue.append(jobId);
    this.idList(topic).push(jobId);
    if (this.ready) {
      yield cb => fs.writeFile(this.path('jobs', `unfinished.${jobId}`), JSON.stringify({
        id: jobId, jobId, topic, priority, payload, payloadType, noRetry, createTime,
      }), cb);
      this.emit('queue-update');
    }
    return jobId;
  }

  *nextJob (topic, worker) {
    let jobId = null;
    for (let i = 0; jobId === null && i < 3; i++) {
      jobId = this.queue(topic, i).pop();
    }
    if (!jobId) {
      return null;
    }
    const jobStatus = this.jobStatus[jobId];
    if (!jobStatus) {
      return this.nextJob(topic, worker);
    }
    jobStatus.status = 'running';
    jobStatus.worker = worker;
    jobStatus.expire = 0;
    try {
      const [jobContent] = yield cb => fs.readFile(this.path('jobs', `unfinished.${jobId}`), cb);
      const job = JSON.parse(jobContent);
      return Object.assign({}, jobStatus, job);
    } catch (err) {
      fs.unlink(this.path('jobs', `unfinished.${jobId}`), err => null);
      jobStatus.queue.done(jobId);
      delete this.jobStatus[jobId];
      return this.nextJob(topic, worker);
    }
  }

  *doneJob (job, isSuccess, noRetry = false) {
    const jobId = job.id;
    const jobStatus = this.jobStatus[jobId];
    if (!jobStatus) {
      return;
    }
    if (isSuccess) {
      yield cb => fs.rename(this.path('jobs', `unfinished.${jobId}`), this.path('jobs', `success.${jobId}`), cb);
      jobStatus.status = 'success';
      jobStatus.expire = Date.now() + 3600 * 1000;
      jobStatus.queue.done(jobId);
    } else {
      if (!job.noRetry && !noRetry && job.retried < job.retries) {
        jobStatus.retried++;
        jobStatus.status = 'pending';
        jobStatus.queue.done(jobId);
        setTimeout(() => {
          if (jobStatus.status === 'pending') {
            jobStatus.queue.append(jobId);
            this.emit('queue-update');
          }
        }, Math.max(5000, job.backoff));
      } else {
        yield cb => fs.rename(this.path('jobs', `unfinished.${jobId}`), this.path('jobs', `failure.${jobId}`), cb);
        jobStatus.status = 'failure';
        jobStatus.expire = Date.now() + 24 * 3600 * 1000;
        jobStatus.queue.done(jobId);
      }
    }
    this.emit('queue-update');
  }

  *sanitize () {
    const topics = Object.keys(this.idLists);
    for (const topic of topics) {
      const topicIdList = this.idLists[topic];
      const newList = [];
      let now = Date.now();
      for (let i = 0; i < topicIdList.length; i++) {
        if (i % 100 === 0) {
          yield cb => setTimeout(cb, 10);
          now = Date.now();
        }
        const jobId = topicIdList[i];
        const jobStatus = this.jobStatus[jobId];
        if (!jobStatus || (jobStatus > 0 && jobStatus.expire < now)) {
          fs.unlink(this.path('jobs', `unfinished.${jobId}`), err => null);
          fs.unlink(this.path('jobs', `success.${jobId}`), err => null);
          fs.unlink(this.path('jobs', `failure.${jobId}`), err => null);
          yield cb => setTimeout(cb, 10);
          now = Date.now();
        } else {
          newList.push(jobId);
        }
      }
      this.idLists[topic] = newList;
    }
  }

  *abortJob (jobId, isErase) {
    this.emit('abort', jobId);
    if (isErase) {
      delete this.jobStatus[jobId];
      fs.unlink(this.path('jobs', `unfinished.${jobId}`), err => null);
      fs.unlink(this.path('jobs', `success.${jobId}`), err => null);
      fs.unlink(this.path('jobs', `failure.${jobId}`), err => null);
    } else {
      const jobStatus = this.jobStatus[jobId];
      if (!jobStatus) {
        return false;
      }
      jobStatus.status = 'failure';
      jobStatus.expire = Date.now() + 24 * 3600 * 1000;
      return true;
    }
  }

  *getJob (jobId, statusOnly) {
    const jobStatus = this.jobStatus[jobId];
    if (!jobStatus) {
      return null;
    }
    if (statusOnly) {
      return jobStatus;
    }
    let prefix = 'unfinished';
    if (jobStatus.status === 'success' || jobStatus.status === 'failure') {
      prefix = jobStatus.status;
    }
    try {
      const [content] = yield cb => fs.readFile(this.path('jobs', `${prefix}.${jobId}`), cb);
      return Object.assign({}, jobStatus, JSON.parse(content));
    } catch (err) {
      return null;
    }
  }

  *getJobs (topic, fn) {
    const ids = this.idList(topic);
    const ret = [];
    for (const id of ids) {
      const jobStatus = this.jobStatus[id];
      if (!jobStatus || !fn(jobStatus)) {
        continue;
      }
      ret.push(jobStatus);
    }
    return ret;
  }
}

class Queue {
  constructor () {
    resolveAsync(this);
    this.reset();
  }
  
  reset () {
    this.counter = {
      pending: 0,
      running: 0,
      finish: 0,
      map: {},
    };

    this.circleList = [];
    this.headPos = 0;
    this.tailPos = 0;
    this.listSize = 0;
    this.listUsed = 0;
  }

  isEmpty () {
    return this.listUsed === 0;
  }

  append (jobId) {
    if (this.counter.map[jobId]) {
      return;
    }
    if (this.listUsed >= this.listSize) {
      const oldList = this.circleList;
      this.listSize = (this.listSize + 10) * 2;
      this.circleList = this.circleList.slice(this.tailPos).concat(this.circleList.slice(0, this.tailPos));
      this.headPos = 0;
      this.tailPos = this.circleList.length;
    }
    this.counter.pending++;
    this.counter.map[jobId] = this.counter.pending;
    this.circleList[this.tailPos] = jobId;
    this.listUsed++;
    this.tailPos++;
    if (this.tailPos >= this.listSize) {
      this.tailPos = 0;
    }
  }

  pop () {
    if (this.isEmpty()) {
      return null;
    }
    const ret = this.circleList[this.headPos];
    this.listUsed--;
    this.headPos++;
    if (this.headPos >= this.listSize) {
      this.headPos = 0;
    }
    this.counter.running = this.counter.map[ret];
    return ret;
  }

  done (jobId) {
    if (this.counter.map[jobId]) {
      delete this.counter.map[jobId];
      this.counter.finish++;
    }
  }

  waiting (jobId) {
    const jobCounter = this.counter.map[jobId]
    if (jobCounter) {
      return Math.max(0, jobCounter - this.counter.running);
    }
    return 0;
  }
}

module.exports = new Store();
