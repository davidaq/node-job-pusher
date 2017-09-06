const store = require('../../store');
const workMaster = require('../../work-master');

module.exports = function* (req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let hasUpdate = true;
  workMaster.on('working-update', (id) => {
    if (!id || req.query.id === id) {
      hasUpdate = true;
    }
  });
  res.write('retry: 60000\n\n');
  let tick = 0;
  let isTimeout = false;
  setTimeout(() => {
    isTimeout = true;
  }, 60000);
  while (!isTimeout && !req.socket.destroyed) {
    if (!hasUpdate) {
      yield cb => setTimeout(cb, 1000 + Math.random() * 1000);
      if (tick++ > 10) {
        res.write('event: keepalive\n');
        res.write('data: keepalive\n\n');
      }
      continue;
    }
    hasUpdate = false;
    const job = yield store.getDetail(req.query.id);
    if (!job) {
      res.write('event: error\n');
      res.write('data: no such job\n\n');
      break;
    }
    const inQueue = (yield store.getQueue(job._id)) || {};
    const counter = (yield store.getCounter(job.topic, job.priority)) || {};
    const send = {
      id: job._id,
      status: job.status,
      worker: job.worker,
      workerUrl: job.worker && job.worker.url,
      retried: job.retried,
      wait: Math.max(0, (inQueue.seq || 0) - (counter.done || 0)),
    };
    res.write('event: status\n');
    res.write(`data: ${JSON.stringify(send)}\n\n`);

    if (job.status === 'success' || job.status === 'failure') {
      break;
    }
  }
  if (!req.socket.destroyed) {
    if (isTimeout) {
      res.write('retry: 5000\n\n');
    } else {
      res.write('event: nomore\n');
      res.write('data: nomore\n\n');
      res.write('retry: 600000\n\n');
    }
    yield cb => setTimeout(cb, 2000);
  }
  res.end();
};
