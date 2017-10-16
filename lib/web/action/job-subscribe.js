const store = require('../../store');
const workMaster = require('../../work-master');

module.exports = function* (req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': '*',
  });
  if (!req.query.id) {
    res.write('event: nomore\n');
    res.write('data: nomore\n\n');
    res.write('retry: 600000\n\n');
    yield cb => setTimeout(cb, 2000);
    return;
  }
  const ids = req.query.id.split(',');

  let hasUpdate = { $: true };
  ids.forEach(id => {
    hasUpdate[id] = 1;
  });

  workMaster.on('working-update', (id) => {
    hasUpdate.$ = true;
    if (!id) {
      ids.forEach(id => {
        hasUpdate[id] = 1;
      });
    } else if (ids.indexOf(id) !== -1) {
      hasUpdate[id] = 1;
    }
  });

  res.write('retry: 60000\n\n');

  let tick = 0;
  let isTimeout = false;
  setTimeout(() => {
    isTimeout = true;
  }, 60000);

  function* stat (id) {
    const job = yield store.getJob(id);
    if (!job) {
      res.write('event: error\n');
      res.write('data: no such job\n\n');
      const index = ids.indexOf(id);
      if (index !== -1) {
        ids.splice(index, 1);
      }
      return;
    }
    const send = {
      id: job.jobId,
      status: job.status,
      worker: job.worker,
      workerUrl: job.worker && job.worker.url,
      retried: job.retried,
      wait: job.queue.waiting(id),
    };
    res.write('event: status\n');
    res.write(`data: ${JSON.stringify(send)}\n\n`);
    
    if (job.status === 'success' || job.status === 'failure') {
      const index = ids.indexOf(id);
      if (index !== -1) {
        ids.splice(index, 1);
      }
    }
  }

  while (!isTimeout && !req.socket.destroyed && ids.length > 0) {
    if (!hasUpdate.$) {
      yield cb => setTimeout(cb, 1000 + Math.random() * 1000);
      if (tick++ > 5) {
        tick = 0;
        res.write('event: keepalive\n');
        res.write('data: keepalive\n\n');
      }
      continue;
    }
    const hadUpdate = hasUpdate;
    hasUpdate = {};
    for (const id of ids) {
      if (hadUpdate[id]) {
        yield* stat(id);
      }
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
