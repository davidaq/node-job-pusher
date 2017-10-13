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
    
    yield cb => fs.mkdir(this.path('jobs'), err => cb());

    this.topic = new DataStore({
      filename: path.join(persistDir, 'topic.db'),
      autoload: true,
    });
    this.topic.persistence.setAutocompactionInterval(24 * 3600 * 1000);

    this.queues = {};
    this.jobStatus = {};

    yield this.scanJobs();
  }

  queue (name, priority) {
    const key = `${name}#${priority}`;
    let ret = this.queues[key];
    if (!ret) {
      this.queues[key] = ret = new Queue();
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
      this.queue(topic, i).destroy();
    }
    yield cb => this.topic.remove({ _id: topic }, cb);
    return true;
  }

  *allCounters () {}

  *appendJob (topic, priority, payload, payloadType = '', noRetry = false) {
    if (priority !== 0 && priority !== 1 && priority !== 2) {
      throw new Error('Can only accept priorities of 0, 1, 2');
    }
    const jobId = uuidv4();
    yield cb => fs.writeFile(path.join(persistDir, 'jobs', `unfinished.${jobId}`), JSON.stringify({
      id: jobId, topic, priority, payload, payloadType, noRetry,
    }), cb);
    const jobStatus = this.jobStatus[jobId] = {
      jobId, topic, priority,
      status: 'pending',
      worker: '',
      retried: 0,
      queue: this.queue(topic, priority),
    };
    jobStatus.queue.append(jobId);
  }

  *retryJob (jobId) {
    const jobStatus = this.jobStatus[jobId];
    if (jobStatus) {
      jobStatus.queue.done(jobId);
      jobStatus.queue.append(jobId);
    }
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
    try {
      const [jobContent] = yield cb => fs.readFile(path.join(persistDir, 'jobs', `unfinished.${jobId}`), cb);
      const job = JSON.parse(jobContent);
      return job;
    } catch (err) {
      fs.unlink(path.join(persistDir, 'jobs', `unfinished.${jobId}`), err => null);
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
      jobStatus.status = 'success';
      jobStatus.expire = Date.now() + 3600 * 1000;
      jobStatus.queue.done(jobId);
    } else {
      if (!job.noRetry && !noRetry && job.retried < job.retries) {
        jobStatus.retried++;
        jobStatus.status = 'pending';
        setTimeout(() => {
          this.retryJob(jobId);
        }, Math.max(5000, job.backoff));
      } else {
        jobStatus.status = 'failure';
        jobStatus.expire = Date.now() + 24 * 3600 * 1000;
        jobStatus.queue.done(jobId);
      }
    }
  }

  *scanJobs () {
    // scan jobs dir, restore unfinished jobs, delete expired job records
  }

  *updateJob () {

  }

  *abortJob () {

  }
}

class Queue {
  constructor () {
    resolveAsync(this);
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

  destroy () {

  }
}
