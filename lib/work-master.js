const store = require('./store');
const { resolveAsync } = require('./resolve-async');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { parse: parseurl } = require('url');

class WorkMaster extends EventEmitter {

  constructor () {
    super();
    this.setMaxListeners(10000);
    resolveAsync(this);
    this.isResolving = false;
    this.resolveAgain = false;
    this.workingWorker = {};
    this.workingJob = {};
    this.doneJob = {};
  }

  setup () {
    store.addListener('topic-update', () => this.loadTopics());
    store.addListener('queue-update', () => this.resolveWork());
    this.loadTopics();
  }

  *loadTopics () {
    this.isResolving = true;
    this.topics = yield store.allTopics();
    for (const topic of this.topics) {
      for (const worker of topic.workers) {
        const workerKey = `${topic._id}#${worker.url}`;
        if (!this.workingWorker[workerKey]) {
          this.workingWorker[workerKey] = { '#': 0 };
        }
      }
    }
    this.isResolving = false;
    this.resolveAgain = false;
    this.resolveWork();
  }

  *resolveWork () {
    if (this.isResolving) {
      this.resolveAgain = true;
      return;
    }
    this.isResolving = true;
    try {
      yield this.doResolveWork();
    } finally {
      this.isResolving = false;
      if (this.resolveAgain) {
        this.resolveAgain = false;
        this.resolveWork();
      }
    }
  }

  *doResolveWork () {
    const idleSlots = [];
    for (const topic of this.topics) {
      for (const worker of topic.workers) {
        const working = this.workingWorker[`${topic._id}#${worker.url}`];
        const idle = worker.concurrency - working['#'];
        if (idle > 0) {
          idleSlots.push({ topic, worker, idle, order: Math.random() });
        }
      }
    }
    idleSlots.sort((a, b) => a.order - b.order);
    let ranJob = false;
    while (idleSlots.length > 0) {
      for (let i = 0; i < idleSlots.length; i++) {
        const slot = idleSlots[i];
        const job = yield store.nextJob(slot.topic._id);
        if (job) {
          slot.idle--;
          const jobHolder = Object.assign(new EventEmitter(), job);
          jobHolder.url = slot.worker.url;
          jobHolder.buffer = Buffer.alloc(0);
          jobHolder.contentType = 'text/plain; charset=utf-8';
          jobHolder.contentEncoding = 'identity';
          jobHolder.retries = slot.topic.retries;
          jobHolder.backoff = slot.topic.backoff;
          jobHolder.timeout = slot.topic.timeout;
          jobHolder.worker = slot.worker;
          jobHolder.state = 0;
          this.workingWorker[`${slot.topic._id}#${slot.worker.url}`][job.id] = jobHolder;
          this.workingWorker[`${slot.topic._id}#${slot.worker.url}`]['#']++;
          this.workingJob[job.id] = jobHolder;
          console.log(new Date().toLocaleString(), 'RUN', job._id, slot.worker.url);
          store.updateJob(job._id, { worker: slot.worker, status: 'running' });
          ranJob = true;
          this.run(jobHolder);
        }
        if (slot.idle <= 0 || !job) {
          idleSlots.splice(i, 1);
          i--;
        }
      }
    }
    if (ranJob) {
      this.emit('working-update');
    }
  }

  run (job) {
    let timeout = setTimeout(() => {
      job.emit('finish', false);
    }, Math.max(5000, job.timeout | 0));
    job.once('finish', isSuccess => {
      clearTimeout(timeout);
      store.doneJob(job, isSuccess);
      this.workingWorker[`${job.topic}#${job.url}`]['#']--;
      job.state = 4;
      this.doneJob[job.id] = { id: job.id, state: 4, buffer: job.buffer, contentType: job.contentType };
      setTimeout(() => {
        delete this.doneJob[job.id];
      }, 10000);
      delete this.workingWorker[`${job.topic}#${job.url}`][job.id];
      delete this.workingJob[job.id];
      this.emit('working-update', job.id);
    });
    const opt = parseurl(job.url);
    opt.method = 'POST';
    job.state = 1;
    const proto = opt.protocol === 'https:' ? https : http;
    const req = proto.request(opt, (res) => {
      if (res.statusCode === 200) {
        if (res.headers['content-type']) {
          job.contentType = res.headers['content-type'];
        }
        if (res.headers['content-encoding']) {
          job.contentEncoding = res.headers['content-encoding'];
        }
        job.state = 2;
        job.emit('response-start');
        res.on('error', () => job.emit('finish', false));
        let lastChunk;
        res.on('data', (chunk) => {
          job.buffer = Buffer.concat([job.buffer, chunk]);
          job.emit('output', chunk);
          lastChunk = chunk;
        });
        res.on('end', () => {
          job.state = 3;
          job.emit('response-end');
          const assume = res.headers['x-assume'] || res.headers['assume'];
          if (assume === 'failure') {
            if (!lastChunk || !/succ(ess)?\s*$/i.test(lastChunk.toString('utf-8'))) {
              job.emit('finish', false);
            } else {
              job.emit('finish', true);
            }
          } else {
            if (lastChunk && /fail(ure)?\s*$/i.test(lastChunk.toString('utf-8'))) {
              job.emit('finish', false);
            } else {
              job.emit('finish', true);
            }
          }
        });
      } else {
        job.emit('finish', false);
      }
    });
    req.on('error', () => job.emit('finish', false));
    req.end(job.payload);
  }

  jobOutputStream (jobId) {
    const job = this.workingJob[jobId] || this.doneJob[jobId];
    if (job) {
      const ret = new EventEmitter();
      const getHead = () => {
        return {
          'access-control-allow-origin': '*',
          'access-control-expose-headers': '*',
          'content-type': job.contentType,
          'content-encoding': job.contentEncoding,
        };
      };
      setTimeout(() => {
        if (job.state >= 2) {
          ret.emit('head', getHead());
          if (job.buffer.length > 0) {
            ret.emit('data', job.buffer);
          }
        } else {
          job.on('response-start', () => {
            ret.emit('head', getHead());
          });
        }
        if (job.state >= 3) {
          ret.emit('end');
        } else {
          job.on('output', chunk => {
            ret.emit('data', chunk);
          });
          job.on('response-end', () => {
            ret.emit('end');
          });
        }
      }, 50);
      return ret;
    }
  }
}

module.exports = new WorkMaster();
