const store = require('../../store');

module.exports = function* (req, res) {
  const job = yield store.getJob(req.query.id);
  if (job) {
    res.writeHead(200, { 'content-type': job.payloadType || 'text/plain' });
    res.end(job.payload);
  } else {
    res.end('');
  }
};
