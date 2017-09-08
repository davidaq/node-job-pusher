const store = require('../../store');

module.exports = function* (req, res) {
  if (yield store.abortJob(req.query.id, req.query.erase === 'y')) {
    res.display({ error: '' });
  } else {
    res.display({ error: 'Job not found' });
  }
};
