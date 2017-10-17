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
  const topicMap = {};
  topics.forEach(topic => {
    topic.counter = [];
    topicMap[topic._id] = topic;
  });
  const dangling = {};
  const counters = yield store.allCounters();
  counters.forEach(counter => {
    const { topic, priority } = counter;
    if (topicMap[topic]) {
      topicMap[topic].counter[priority - 0] = counter;
    } else {
      if (!dangling[topic]) {
        dangling[topic] = { _id: topic, counter: [] };
      }
      dangling[topic].counter[priority - 0] = counter;
    }
  });
  res.display({ topics, dangling: Object.keys(dangling).map(k => dangling[k]), alert }, 'index');
}
