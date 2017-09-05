const store = require('./store');
const { resolveAsync } = require('./resolve-async');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { parseurl: parse } = require('url');

class WorkMaster {

  constructor () {
    resolveAsync(this);
    this.isResolving = false;
    this.resolveAgain = false;
    this.workingWorker = {};
    this.workingJob = {};
  }

  setup () {
    store.addListener('topic-update', () => this.loadTopics());
    store.addListener('queue-update', () => this.resolveWork());
    this.loadTopics();
  }

  *loadTopics () {
    this.topics = yield store.allTopics();
    for (const topic of this.topics) {
      for (const worker of topic.workers) {
        const workerKey = `${topic}#${worker.url}`;
        if (!this.workingWorker[workerKey]) {
          this.workingWorker[workerKey] = { '#': 0 };
        }
      }
    }
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
        const working = this.workingWorker[`${topic}#${worker.url}`];
        for (let i = working['#']; i < worker.concurrency; i++) {
          idleSlots.push({ topic: topic._id, url: worker.url, retries: topic.retries, backoff: topic.backoff });
        }
      }
    }
    for (const slot of idleSlots) {
      const job = yield store.nextJob(slot.topic);
      if (job) {
        const jobHolder = Object.assign(new EventEmitter(), job);
        jobHolder.url = slot.url;
        jobHolder.buffer = Buffer.alloc(0);
        jobHolder.contentType = 'text/plain; charset=utf-8';
        jobHolder.retries = slot.retries;
        jobHolder.backoff = slot.backoff;
        this.workingWorker[`${topic}#${worker.url}`][job.id] = jobHolder;
        this.workingWorker[`${topic}#${worker.url}`]['#']++;
        this.workingJob[job.id] = jobHolder;
        this.run(job);
      }
    }
  }

  run (job) {
    job.once('fail', () => {
      store.doneJob(job, false);
      job.emit('finish', false);
    });
    job.once('success', () => {
      store.doneJob(job, true);
      job.emit('finish', true);
    });
    job.once('finish', () => {
      this.workingWorker[`${job.topic}#${job.url}`]['#']--;
      delete this.workingWorker[`${job.topic}#${job.url}`][job.id];
      delete this.workingJob[job.id];
    });
    const opt = parseurl(job.url);
    const proto = opt.protocol === 'https:' ? https : http;
    const req = proto.request(opt, (res) => {
      if (res.statusCode === 200) {
        if (res.headers['content-type']) {
          job.contentType = res.headers['content-type'];
        }
        res.on('error', () => job.emit('fail'));
        let lastChunk;
        res.on('data', (chunk) => {
          job.buffer = Buffer.concat(job.buffer, chunk);
          job.emit('output', chunk);
          lastChunk = chunk;
        });
        res.on('end', () => {
          if (lastChunk && /fail(ure)?\s*$/i.test(lastChunk.toString('utf-8'))) {
            job.emit('fail');
          } else {
            job.emit('success');
          }
        });
      } else {
        job.emit('fail');
      }
    });
    req.on('error', () => job.emit('fail'));
    req.end(job.payload);
  }

  jobOutputStream (jobId) {
    
  }
}

module.exports = new WorkMaster();
