const store = require('../../store');

module.exports = function* (req, res) {
  const [job] = yield store.getJobs({ _id: req.query.id });
  if (job) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(job.payload);
  } else {
    res.end('');
  }
};
