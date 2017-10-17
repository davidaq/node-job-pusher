const store = require('../../store');

module.exports = function* (req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': '*',
  });
  const updated = new Set();
  const listener = queue => {
    if (queue) {
      updated.add(queue);
    }
  };
  store.addListener('queue-update', listener);
  let tick = 0;
  while (!req.socket.destroyed) {
    yield cb => setTimeout(cb, 1000 + Math.random() * 1000);
    if (updated.size > 0) {
      updated.forEach(queue => {
        const { topic, priority, counter: { pending, running, finish } } = queue;
        res.write('event: update\n');
        res.write(`data: ${JSON.stringify({ topic, priority, pending, running, finish })}\n\n`);
      });
      updated.clear();
    } else if (tick++ > 5) {
      tick = 0;
      res.write('event: keepalive\n');
      res.write('data: keepalive\n\n');
    }
  }
  store.removeListener('queue-update', listener);
}
