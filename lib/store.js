const DataStore = require('nedb');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { resolveAsync } = require('./resolve-async');

class Store extends EventEmitter {
  constructor () {
    super();
    resolveAsync(this);
    this.ready = false;
    this.doneCounterCache = {};
  }

  *setup (persistDir) {
    this.persistDir = persistDir;
    this.topic = new DataStore({
      filename: persistDir ? path.join(persistDir, 'topic.db') : undefined,
      autoload: true,
    });
    this.topic.persistence.setAutocompactionInterval(24 * 3600 * 1000);
    
    this.counter = new DataStore({
      filename: persistDir ? path.join(persistDir, 'counter.db') : undefined,
      autoload: true,
    });
    this.counter.persistence.setAutocompactionInterval(24 * 3600 * 1000);

    this.detail = new DataStore({
      filename: persistDir ? path.join(persistDir, 'detail.db') : undefined,
      autoload: true,
    });
    this.detail.persistence.setAutocompactionInterval(3600 * 1000);
    this.detail.ensureIndex({ fieldName: 'topic' });
    this.detail.ensureIndex({ fieldName: 'expire', expireAfterSeconds: 0 });

    this.queue = new DataStore({
      filename: persistDir ? path.join(persistDir, 'queue.db') : undefined,
      autoload: true,
    });
    this.queue.persistence.setAutocompactionInterval(180 * 1000);
    this.queue.ensureIndex({ fieldName: 'topic' });
    this.queue.ensureIndex({ fieldName: 'seq' });
    this.queue.ensureIndex({ fieldName: 'working' });
    yield this.restoreUnfinished();
    this.ready = true;
    this.emit('topic-update');
  }

  *restoreUnfinished () {
    const [affected, docs] = yield cb => this.queue.update({ working: 1 }, { $set: { working: 0 } }, { multi: true, returnUpdatedDocs: true }, cb);
    const ids = docs.map(v => v._id);
    yield cb => this.detail.update({ _id: { $in: ids } }, { $set: { status: 'pending' } }, { multi: true }, cb);
  }

  *appendJob (payload, topic = 'default', priority = 1, payloadType = '', noRetry = false) {
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
        status: 'pending',
        createtime: new Date(),
        worker: '',
        payloadType,
        noRetry,
      };
      const [insertedDetail] = yield cb => this.detail.insert(detailInsertData, cb);
      const queueInsertData = {
        _id: insertedDetail._id,
        topic: topicP,
        seq: counterDoc.pending,
        working: 0,
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
      yield cb => this.queue.update({ _id: jobId }, { $set: { seq: counterDoc.pending, working: 0 } }, cb);
      this.emit('queue-update');
    }
  }

  *nextJob (topic) {
    const [doc, priority] = yield this.nextJobOfPriority(topic);
    if (doc) {
      yield cb => this.queue.update({ _id: doc._id }, { $set: { working: 1 } }, cb);
      yield cb => this.counter.update({ _id: `${topic}#${priority}` }, { $set: { running: doc.seq } }, cb);
      const [job] = yield cb => this.detail.findOne({ _id: doc._id }).exec(cb);
      if (job && job.status === 'pending') {
        job.id = job._id;
        job.seq = doc.seq;
        return job;
      } else {
        yield cb => this.queue.remove({ _id: doc._id }, cb);
        yield cb => this.counter.update({ _id: `${topic}#${priority}` }, { $set: { done: doc.seq } }, cb);
        return yield this.nextJob(topic);
      }
    }
  }

  *nextJobOfPriority (topic, priority = null) {
    if (priority === null) {
      for (let i = 0; i < 3; i++) {
        const doc = yield this.nextJobOfPriority(topic, i);
        if (doc) {
          return [doc, i];
        }
      }
      return [];
    } else {
      const [docs] = yield cb => this.queue.find({ topic: `${topic}#${priority}`, working: 0 }).sort({ seq: 1 }).limit(1).exec(cb);
      if (docs[0]) {
        return docs[0];
      }
    }
  }

  *allTopics () {
    const [docs] = yield cb => this.topic.find().exec(cb);
    return docs;
  }

  *allCounters () {
    const [docs] = yield cb => this.counter.find().exec(cb);
    return docs;
  }

  *doneJob (job, isSuccess, noRetry = false) {
    const updateDoc = {};
    if (isSuccess) {
      updateDoc.expire = new Date(Date.now() + 3600 * 1000);
      updateDoc.status = 'success';
      yield cb => this.queue.remove({ _id: job.id }, cb);
    } else {
      if (!job.noRetry && !noRetry && job.retried < job.retries) {
        updateDoc.retried = job.retried + 1;
        updateDoc.status = 'pending';
        setTimeout(() => {
          this.retryJob(job.id, job.topic, job.priority);
        }, Math.max(5000, job.backoff));
      } else {
        updateDoc.expire = new Date(Date.now() + 24 * 3600 * 1000);
        updateDoc.status = 'failure';
        yield cb => this.queue.remove({ _id: job.id }, cb);
      }
    }
    const counterKey = `${job.topic}#${job.priority}`;
    if (!this.doneCounterCache[counterKey] || this.doneCounterCache[counterKey] < job.seq) {
      this.doneCounterCache[counterKey] = job.seq;
      yield cb => this.counter.update({ _id: counterKey }, { $set: { done: job.seq } }, cb);
    }
    yield cb => this.detail.update({ _id: job.id }, { $set: updateDoc }, cb);
    this.emit('queue-update');
  }

  *updateJob (jobId, update) {
    const [affected] = yield cb => this.detail.update({ _id: jobId, status: 'pending' }, { $set: update }, cb);
    return affected > 0;
  }

  *abortJob (jobId, isErase) {
    if (isErase) {
      yield cb => this.detail.remove({ _id: jobId }, cb);
      yield cb => this.queue.remove({ _id: jobId }, cb);
      return true;
    } else {
      const [affected] = yield cb => this.detail.update({ _id: jobId, status: 'pending' }, { $set: { status: 'failure', expire: new Date(Date.now() + 60 * 1000) } }, cb);
      return affected > 0;
    }
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
    while (true) {
      const [doc] = yield this.nextJobOfPriority(topic);
      if (doc) {
        if (yield this.getDetail(doc._id)) {
          return false;
        } else {
          yield cb => this.queue.remove({ _id: doc._id }, cb);
        }
      } else {
        break;
      }
    }
    yield cb => this.topic.remove({ _id: topic }, cb);
    for (let i = 0; i < 3; i++) {
      yield cb => this.counter.remove({ _id: `${topic}#${i}` }, cb);
    }
    return true;
  }

  *getJobs (where, page = 1, pageSize = 20) {
    const [docs] = yield cb => this.detail.find(where).skip(pageSize * (page - 1)).limit(pageSize).sort({ createtime: -1 }).exec(cb);
    return docs;
  }

  *getDetail (id) {
    const [doc] = yield cb => this.detail.findOne({ _id: id }).exec(cb);
    return doc;
  }

  *getQueue (id) {
    const [doc] = yield cb => this.queue.findOne({ _id: id }).exec(cb);
    return doc;
  }

  *getCounter (topic, priority) {
    const [doc] = yield cb => this.counter.findOne({ _id: `${topic}#${priority}` }).exec(cb);
    return doc;
  }
}

module.exports = new Store();
