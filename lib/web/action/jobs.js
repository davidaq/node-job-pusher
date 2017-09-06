const store = require('../../store');

module.exports = function* (req, res) {
  const query = req.query;
  if (!query.pending && !query.running && !query.success && !query.failure) {
    query.pending = 1;
    query.running = 1;
  }
  if (!query.p0 && !query.p1 && !query.p2) {
    query.p0 = 1;
    query.p1 = 1;
    query.p2 = 1;
  }
  query.page -= 0;
  if (!query.page) {
    query.page = 1;
  }
  const filter = {};

  if (query.topic) {
    filter.topic = query.topic;
  }

  filter.priority = { $in: [] };
  [0, 1, 2].forEach(i => {
    if (query[`p${i}`]) {
      filter.priority.$in.push(i);
    }
  });
  if (filter.priority.$in.length === 3) {
    delete filter.priority;
  }

  filter.status = { $in: [] };
  ['pending', 'running', 'failure', 'success'].forEach(status => {
    if (query[status]) {
      filter.status.$in.push(status);
    }
  });
  if (filter.status.$in.length === 4) {
    delete filter.priority;
  }

  const highlight = {};
  if (query.highlight) {
    query.highlight.split(',').forEach(item => {
      highlight[item] = 1;
    });
  }

  const jobs = yield store.getJobs(filter, query.page);
  res.display({ query, jobs, highlight }, 'jobs');
};
