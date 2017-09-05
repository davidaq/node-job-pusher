const [node, source, port, persitDir] = process.argv;

if (!port) {
  console.log("Run as: job-pusher <port> <persit dir>");
  process.exit(1);
}

const store = require('./store');
const workMaster = require('./work-master');
const server = require('./server');

store.setup(persitDir);
workMaster.setup();
// server.setup(port);
