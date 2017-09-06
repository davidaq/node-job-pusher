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
    for (let i = 0; i < repeat; i++) {
      const id = yield store.appendJob(job.payload, job.topic, job.priority);
      ids.push(id);
    }
    if (job.from === 'form') {
      res.writeHead(302, { location: `/jobs?topic=${encodeURIComponent(job.topic)}&highlight=${encodeURIComponent(ids.join(','))}` });
      res.end();
      return;
    } else {
      res.display(ids);
      return;
    }
  }
  const topics = yield store.allTopics();
  res.display({ topics: topics.map(v => v._id) }, 'job-create');
}
