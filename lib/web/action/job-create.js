const store = require('../../store');
const qs = require('qs');

module.exports = function* (req, res) {
  if (req.method === 'POST') {
    let job = req.body.toString();
    try {
      job = JSON.parse(job);
    } catch (err) {
      job = qs.parse(job);
    }
    job.priority = job.priority - 0;
    if ([0, 1, 2].indexOf(job.priority) === -1) {
      job.priority = 1;
    }
    if (!job.topic) {
      job.topic = 'default';
    }
    const ids = [];
    let repeat = job.repeat - 0;
    if (!(repeat > 1)) {
      repeat = 1;
    }
    if (typeof job.payloadType !== 'string') {
      job.payloadType = '';
    }
    if (typeof job.payload !== 'string') {
      job.payload = JSON.stringify(job.payload);
      if (!job.payloadType) {
        job.payloadType = 'application/json';
      }
    }
    for (let i = 0; i < repeat; i++) {
      const id = yield store.appendJob(job.payload, job.topic, job.priority, job.payloadType);
      ids.push(id);
    }
    if (job.from === 'form') {
      res.writeHead(302, { location: `/jobs?topic=${encodeURIComponent(job.topic)}&highlight=${encodeURIComponent(ids.join(','))}` });
      res.end();
      return;
    } else {
      res.writeHead(200, {
        'access-control-allow-origin': '*',
        'access-control-expose-headers': '*',
      });
      res.display(ids);
      return;
    }
  } else if (req.query.duplicate) {
    const job = yield store.getDetail(req.query.duplicate);
    if (job) {
      const id = yield store.appendJob(job.payload, job.topic, job.priority);
      res.writeHead(302, { location: `/jobs?topic=${encodeURIComponent(job.topic)}&highlight=${encodeURIComponent(id)}` });
      res.end();
      return;
    }
  }
  const topics = yield store.allTopics();
  res.display({ query: req.query, topics: topics.map(v => v._id) }, 'job-create');
}
