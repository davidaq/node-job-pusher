const DataStore = require('nedb');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const resolveAsync = require('./resolve-async');

class Store extends EventEmitter {
  constructor () {
    super();
    resolveAsync(this);
  }

  setup (persitDir) {
    this.topic = new DataStore({
      filename: persitDir ? path.join(persitDir, 'topic.db') : undefined,
      autoload: true,
    });
    this.topic.persistence.setAutocompactionInterval(24 * 3600 * 1000);
    
    this.counter = new DataStore({
      filename: persitDir ? path.join(persitDir, 'counter.db') : undefined,
      autoload: true,
    });
    this.counter.persistence.setAutocompactionInterval(24 * 3600 * 1000);

    this.detail = new DataStore({
      filename: persitDir ? path.join(persitDir, 'detail.db') : undefined,
      autoload: true,
    });
    this.detail.persistence.setAutocompactionInterval(3600 * 1000);
    this.detail.ensureIndex({ fieldName: 'expire', expireAfterSeconds: 0 });

    this.queue = new DataStore({
      filename: persitDir ? path.join(persitDir, 'queue.db') : undefined,
      autoload: true,
    });
    this.queue.persistence.setAutocompactionInterval(10 * 1000);
    this.queue.ensureIndex({ fieldName: 'topic' });
    this.queue.ensureIndex({ fieldName: 'seq' });
    this.queue.ensureIndex({ fieldName: 'working' });
    this.queue.update({ working: 1 }, { working: 0 });
  }

  *appendJob (payload, topic = 'default', priority = 1) {
    if (priority !== 0 && priority !== 1 && priority !== 2) {
      throw new Error('Can only accept');
    }
    const topicP = `${topic}#${priority}`;
    const [affected, counterDoc] = yield cb => this.counter.update({ _id: topicP }, { $inc: { pending: 1 } }, { returnUpdatedDocs: true, upsert: true }, cb);
    if (affected !== 1) {
      throw new Error('Bad topic');
    } else {
      const detailInsertData = {
        topic,
        payload,
        priority,
        retried: 0,
        createtime: Date.now(),
      };
      const [insertedDetail] = yield cb => this.detail.insert(detailInsertData, cb);
      const queueInsertData = {
        _id: insertedDetail._id,
        topic: topicP,
        seq: counterDoc.pending,
      };
      yield cb => this.queue.insert(queueInsertData, cb);
      this.emit('queue-update');
      return insertedDetail._id;
    }
  }

  *retryJob (jobId, topic, priority) {
    const topicP = `${topic}#${priority}`;
    const [affected, counterDoc] = yield cb => this.counter.update({ _id: topicP }, { $inc: { pending: 1 } }, { returnUpdatedDocs: true, upsert: true }, cb);
    if (affected !== 1) {
      throw new Error('Bad topic');
    } else {
      yield cb => this.queue.remove({ _id: jobId }, cb);
      const queueInsertData = {
        _id: jobId,
        topic: topicP,
        seq: counterDoc.pending,
      };
      yield cb => this.queue.insert(queueInsertData, cb);
    }
  }

  *nextJob (topic) {
    for (let i = 0; i < 3; i++) {
      const doc = yield this.nextJobOfPriority(topic, 0);
      if (doc) {
        yield cb => this.queue.update({ _id: doc._id }, { working: 1 }, cb);
        const [{ payload }] = cb => this.detail.findOne({ _id: doc._id });
        return { id: doc._id, payload };
      }
    }
  }

  *nextJobOfPriority (topic, priority) {
    const [docs] = yield cb => this.queue.find({ topic: `${topic}#${priority}`, working: 0 }).sort({ seq: 1 }).limit(1).exec(cb);
    if (docs[0]) {
      return docs[0];
    }
  }
  
  *createTopic (name) {
    const topicInsertData = {
      _id: name,
      retries: 5,
      backoff: 5000,
      timeout: 300000,
      worker: [],
    };
    yield cb => this.topic.insert(topicInsertData, cb);
    this.emit('topic-update');
  }

  *allTopics () {
    const [docs] = yield cb => this.topic.find().exec(cb);
    return docs;
  }

  *assignJob (jobId, workerUrl) {
    yield this.queue.update({ _id: jobId }, { working: 1 });
  }

  *doneJob (job, isSuccess) {
    const updateDoc = { output: job.output.toString('base64'), outputType: job.contentType };
    if (isSuccess) {
      updateDoc.expire = new Date(Date.now() + 24 * 3600 * 1000);
      updateDoc.status = 'success';
      yield cb => this.queue.remove({ _id: job.id }, cb);
    } else {
      if (job.retried < job.retries) {
        updateDoc.retried = job.retried + 1;
        setTimeout(() => {
          this.retryJob(job.id, job.topic, job.priority);
        }, Math.max(5000, job.backoff));
      } else {
        updateDoc.status = 'failure';
        yield cb => this.queue.remove({ _id: job.id }, cb);
      }
    }
    yield cb => this.detail.update({ _id: job.id }, updateDoc, cb);
    this.emit('queue-update');
  }
}

module.exports = new Store();
