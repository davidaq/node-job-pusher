const store = require('../../store');
const qs = require('qs');

module.exports = function* (req, res) {
  if (req.method === 'POST') {
    const job = qs.parse(req.body.toString());
    job.priority = job.priority - 0;
    if ([0, 1, 2].indexOf(job.priority) === -1) {
      job.priority = 1;
    }
    if (!job.topic) {
      job.topic = 'default';
    }
    const id = yield store.appendJob(job.payload, job.topic, job.priority);
    if (job.from === 'form') {
      res.writeHead(302, { location: `/jobs?topic=${encodeURIComponent(job.topic)}&highlight=${encodeURIComponent(id)}` });
      res.end();
      return;
    } else {
      res.display(id);
      return;
    }
  }
  const topics = yield store.allTopics();
  res.display({ topics: topics.map(v => v._id) }, 'job-create');
}
