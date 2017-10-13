const [node, source, port, persitDir] = process.argv;

if (!port || !persitDir) {
  console.log("Run as: job-pusher <port> <persit dir>");
  process.exit(1);
}

const store = require('./store');
const workMaster = require('./work-master');
const apiServer = require('./api-server');

store.setup(persitDir);
workMaster.setup();
apiServer.setup(port);
