const store = require('../../store');
const workMaster = require('../../work-master');

function* getStream (req) {
  let noCheck = true;
  let checked = false;
  for (let i = 0; i < 300 && !req.socket.destroyed; i++) {
    const liveStream = workMaster.jobOutputStream(req.query.id);
    if (liveStream) {
      return liveStream;
    }
    if (!noCheck && !checked) {
      checked = true;
      const job = yield store.getDetail(req.query.id);
      if (!job || job.status !== 'pending') {
        break;
      }
      const topic = yield store.getTopic(job.topic);
      if (!topic || topic.workers.length === 0) {
        break;
      }
    }
    yield cb => setTimeout(cb, 1000 + Math.random() * 1000);
    noCheck = false;
  }
}

module.exports = function* (req, res) {
  const liveStream = yield* getStream(req);
  if (liveStream) {
    let isSSE = false;
    liveStream.on('head', head => {
      isSSE = head['content-type'] === 'text/eventstream';
      res.writeHead(200, head);
    });
    liveStream.on('data', chunk => {
      res.write(chunk);
    });
    liveStream.on('end', () => {
      if (isSSE) {
        setTimeout(() => res.end(), 2000);
      } else {
        res.end();
      }
    });
  } else {
    res.writeHead(404, {
      'access-control-allow-origin': '*',
      'access-control-expose-headers': '*',
    });
    res.end('');
  }
};
