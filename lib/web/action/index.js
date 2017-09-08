const store = require('../../store');

module.exports = function* (req, res) {
  let alert = '';
  if (req.query.remove) {
    if (yield store.removeTopic(req.query.remove)) {
      alert = 'Topic removed';
    } else {
      alert = 'Can not remove topic when queue is not empty';
    }
  }
  const topics = yield store.allTopics();
  const counters = yield store.allCounters();
  const topicMap = {};
  topics.forEach(topic => {
    topic.counter = [];
    topicMap[topic._id] = topic;
  });
  const dangling = counters.filter(counter => {
    const [topic, priority] = counter._id.split('#');
    if (topicMap[topic]) {
      topicMap[topic].counter[priority - 0] = counter;
      return false;
    }
    return true;
  });
  res.display({ topics, dangling, alert }, 'index');
}
