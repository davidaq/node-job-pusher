const store = require('./store');
const { resolveAsync } = require('./resolve-async');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { parse: parseurl } = require('url');
const { createGunzip } = require('zlib');

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
    this.abortJobFn = {};
  }

  setup () {
    store.addListener('abort', (id) => this.abortJobFn[id] && this.abortJobFn[id]());
    store.addListener('topic-update', () => this.loadTopics());
    store.addListener('queue-update', () => this.resolveWork());
  }

  *loadTopics () {
    if (!store.ready) {
      return;
    }
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
    if (!store.ready) {
      return;
    }
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
        const job = yield store.nextJob(slot.topic._id, slot.worker);
        if (job) {
          slot.idle--;
          const jobHolder = Object.assign(new EventEmitter(), job);
          jobHolder.id = job.jobId;
          jobHolder.url = slot.worker.url;
          jobHolder.buffer = Buffer.alloc(0);
          jobHolder.contentType = 'text/plain; charset=utf-8';
          jobHolder.contentEncoding = 'identity';
          jobHolder.retries = slot.topic.retries;
          jobHolder.backoff = slot.topic.backoff;
          jobHolder.timeout = slot.topic.timeout;
          jobHolder.worker = slot.worker;
          jobHolder.state = 0;
          this.workingWorker[`${slot.topic._id}#${slot.worker.url}`][jobHolder.id] = jobHolder;
          this.workingWorker[`${slot.topic._id}#${slot.worker.url}`]['#']++;
          this.workingJob[jobHolder.id] = jobHolder;
          console.log(new Date().toLocaleString(), 'RUN', jobHolder.jobId, slot.worker.url);
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
      delete this.abortJobFn[job.id];
      clearTimeout(timeout);
      store.doneJob(job, isSuccess);
      this.workingWorker[`${job.topic}#${job.url}`]['#']--;
      job.state = 4;
      this.doneJob[job.id] = { id: job.id, state: 4, buffer: job.buffer, contentType: job.contentType, contentEncoding: job.contentEncoding };
      setTimeout(() => {
        delete this.doneJob[job.id];
      }, 10000);
      delete this.workingWorker[`${job.topic}#${job.url}`][job.id];
      delete this.workingJob[job.id];
      this.emit('working-update', job.id);
    });
    const opt = parseurl(job.url);
    opt.method = 'POST';
    opt.headers = {};
    if (!job.noRetry) {
      opt.headers['x-retries'] = job.retries;
      opt.headers['x-retried'] = job.retried;
    } else {
      opt.headers['x-retries'] = 0;
      opt.headers['x-retried'] = 0;
    }
    if (job.payloadType) {
      opt.headers['content-type'] = job.payloadType;
    }
    job.state = 1;
    const proto = opt.protocol === 'https:' ? https : http;
    const req = proto.request(opt, (res) => {
      if (res.statusCode === 200) {
        if (res.headers['content-type']) {
          job.contentType = res.headers['content-type'];
        }
        let decoder;
        if (res.headers['content-encoding']) {
          job.contentEncoding = res.headers['content-encoding'];
          if (job.contentEncoding === 'gzip') {
            decoder = createGunzip();
          }
        }
        job.state = 2;
        job.emit('response-start');
        res.on('error', () => job.emit('finish', false));
        const lastChunk = [];
        let lastChunkLen = 0;
        const trackLastChunk = (chunk) => {
          lastChunk.push(chunk);
          lastChunkLen += chunk.length;
          while (lastChunk.length > 1 && lastChunkLen > 50) {
            lastChunkLen -= lastChunk.shift().length;
          }
        };
        res.on('data', (chunk) => {
          job.buffer = Buffer.concat([job.buffer, chunk]);
          job.emit('output', chunk);
          if (decoder) {
            decoder.write(chunk);
          } else {
            trackLastChunk(chunk);
          }
        });
        if (decoder) {
          decoder.on('data', (chunk) => {
            trackLastChunk(chunk);
          });
          res.on('end', () => {
            decoder.end();
          });
          decoder.on('error', () => job.emit('finish', false));
        }
        (decoder || res).on('end', () => {
          job.state = 3;
          job.emit('response-end');
          const assume = res.headers['x-assume'] || res.headers['assume'];
          const lastStr = lastChunk.length > 0 ? Buffer.concat(lastChunk).toString('utf-8') : '';
          if (assume === 'failure') {
            job.emit('finish', /succ(ess)?\s*$/i.test(lastStr));
          } else {
            job.emit('finish', !/fail(ure)?\s*$/i.test(lastStr));
          }
        });
      } else {
        job.emit('finish', false);
      }
    });
    req.on('error', () => job.emit('finish', false));
    req.end(job.payload);
    this.abortJobFn[job.id] = () => {
      console.log('ABORT');
      req.abort();
      job.emit('finish', false);
    };
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
          job.once('response-start', () => {
            ret.emit('head', getHead());
          });
        }
        if (job.state >= 3) {
          ret.emit('end');
        } else {
          job.on('output', chunk => {
            ret.emit('data', chunk);
          });
          job.once('finish', () => {
            ret.emit('end');
          });
        }
      }, 50);
      return ret;
    }
  }
}

module.exports = new WorkMaster();
