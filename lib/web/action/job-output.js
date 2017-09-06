const store = require('../../store');
const workMaster = require('../../work-master');

module.exports = function* (req, res) {
  const liveStream = workMaster.jobOutputStream(req.query.id);
  if (liveStream) {
    liveStream.on('head', ({ contentType }) => {
      res.writeHead(200, { 'content-type': contentType || 'text/plain' });
    });
    liveStream.on('data', chunk => {
      res.write(chunk);
    });
    liveStream.on('end', () => {
      res.end();
    });
  } else {
    const [job] = yield store.getJobs({ _id: req.query.id });
    if (job && job.output) {
      res.writeHead(200, { 'content-type': job.outputType || 'text/plain' });
      res.end(new Buffer(job.output, 'base64'));
    } else {
      res.end('');
    }
  }
};
