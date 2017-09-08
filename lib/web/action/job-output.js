const store = require('../../store');
const workMaster = require('../../work-master');

module.exports = function* (req, res) {
  const liveStream = workMaster.jobOutputStream(req.query.id);
  if (liveStream) {
    liveStream.on('head', head => {
      res.writeHead(200, head);
    });
    liveStream.on('data', chunk => {
      res.write(chunk);
    });
    liveStream.on('end', () => {
      res.end();
    });
  } else {
    res.writeHead(404);
    res.end('');
  }
};
