const DataStore = require('nedb');
const fs = require('fs');
const path = require('path');
const { resolveAsync } = require('./util');

class Store {
  constructor () {
    resolveAsync(this);
  }

  setup (persitPath) {
    // todo ensure dir

    this.topic = new DateStore({
      filename: persitPath ? path.join(persitPath, 'topic.db') : undefined,
    });
    this.topic.persistence.setAutocompactionInterval(24 * 3600 * 1000);
    
    this.counter = new DateStore({
      filename: persitPath ? path.join(persitPath, 'counter.db') : undefined,
    });
    this.counter.persistence.setAutocompactionInterval(24 * 3600 * 1000);

    this.detail = new DataStore({
      filename: persitPath ? path.join(persitPath, 'detail.db') : undefined,
    });
    this.detail.persistence.setAutocompactionInterval(3600 * 1000);

    this.queue = new DataStore({
      filename: persitPath ? path.join(persitPath, 'queue.db') : undefined,
    });
    this.queue.persistence.setAutocompactionInterval(10 * 1000);
    this.queue.ensureIndex({ fieldName: 'topic' });
    this.queue.ensureIndex({ fieldName: 'seq' });
  }

  createTopic (name) {
    const topicInsertData = {
      _id: name,
      pending: 0,
      running: 0,
      done: 0,
      worker: [],
    };
    this.topic.insert(topicInsertData);
  }

  *appendJob (payload, topic = 'default', priority = 1) {
    if (priority !== 0 && priority !== 1 && priority !== 2) {
      throw new Error('Can only accept');
    }
    this.topic.update({ _id: topic }, { $inc: { pending: 1 } }, { returnUpdatedDocs: true }, (err, affected, topicDoc) => {
      if (affected !== 1) {
        cb(new Error('Bad topic'));
      } else {
        const detailInsertData = {
          topic: topic,
          detail: detail,
          createtime: Date.now(),
        };
        this.detail.insert(detailInsertData, (err, insertedDetail) => {
          const queueInsertData = {
            _id: insertedDetail._id,
            topic: topic,
            seq: topicDoc.pending,
          };
          this.queue.insert(queueInsertData, (err, insertedQueueItem) => {
            cb(null, insertedDetail._id);
          });
        });
      }
    });
  }

  _pushCounter (topic, priority) {

  }

  dequeueJob () {

  }

  failJob (topic, detail, cb) {

  }

}

module.exports = new Store();
