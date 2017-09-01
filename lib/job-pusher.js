const [node, source, port, persitPath] = process.argv;

if (!port) {
  console.log("Run as: job-pusher <port> <persit path>");
  process.exit(1);
}

const store = require('./store');
store.setup(persitPath);

const server = require('./server');
server.setup(port);
