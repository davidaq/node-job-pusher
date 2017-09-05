const qs = require('qs');
const store = require('../../store');

module.exports = function* (req, res) {
  let topic;
  if (req.method === 'POST') {
    topic = qs.parse(req.body.toString());
    topic.workers = [];
    const existedUrl = {};
    if (Array.isArray(topic.workerurl) && Array.isArray(topic.workerconcurrency)) {
      for (let i = 0; i < topic.workerurl.length; i++) {
        const url = topic.workerurl[i].trim();
        if (!url || existedUrl[url]) {
          topic.error = 'A worker must have a distinct url';
        }
        existedUrl[url] = 1;
        topic.workers.push({
          url,
          concurrency: topic.workerconcurrency[i],
        });
      }
    }
    delete topic.workerurl;
    delete topic.workerconcurrency;
    if (!topic._id) {
      topic.error = 'Must assign topic name';
    }
    if (!topic.error) {
      yield store.saveTopic(topic);
      res.writeHead(302, { location: '/topics' });
      res.end();
      return;
    }
  } else {
    if (req.query.id) {
      topic = yield store.getTopic(req.query.id);
    }
    topic = topic || {
      _id: '',
      retries: 5,
      backoff: 5000,
      timeout: 300000,
      workers: [],
    };
  }
  topic.error = topic.error || '';
  res.display(topic, 'topic-edit');
}
