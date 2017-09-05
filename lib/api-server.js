const express = require('express');
const serveStatic = require('serve-static');
const concatStream = require('concat-stream');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { wrap } = require('./resolve-async');

class ApiServer {
  setup(port) {
    this.app = express();

    this.app.use((req, res, next) => {
      console.log(new Date().toLocaleString(), req.method, req.url);
      if (req.url === '/') {
        req.url = '/index';
      }
      next();
    });
    this.app.use('/static', serveStatic(path.join(__dirname, 'web', 'static')));
    this.app.use((req, res, next) => {
      const fpath = req.url.substr(1).replace(/\?.*$/, '');
      try {
        delete require.cache[require.resolve(`./web/action/${fpath}`)];
        const func = wrap(require(`./web/action/${fpath}`));
        res.display = (data, tpl = '') => {
          fs.readFile(path.join(__dirname, 'web', 'view', tpl + '.ejs'), 'utf-8', (err, content) => {
            if (err) {
              res.end(JSON.stringify(data));
            } else {
              try {
                res.end(ejs.compile(content)(data));
              } catch (err) {
                res.writeHead(500, {
                  'content-type': 'text/plain; charset=utf-8',
                });
                res.end(err.message);
              }
            }
          });
        };
        req.pipe(concatStream(inBuf => {
          req.body = inBuf;
          func(req, res).catch(err => {
            res.writeHead(500, {
              'content-type': 'text/plain; charset=utf-8',
            });
            res.end(err.stack);
          });
        }));
      } catch (err) {
        res.writeHead(404, {
          'content-type': 'text/plain; charset=utf-8',
        });
        res.end(err.stack);
      }
    });

    this.app.listen(port, (err) => {
      if (err) {
        console.error(err);
        process.exit(1);
      } else {
        console.log(`Listening on port ${port}`);
      }
    });
  }
}

module.exports = new ApiServer();
