const express = require('express');
const serveStatic = require('serve-static');
const concatStream = require('concat-stream');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { wrap } = require('./resolve-async');

class ApiServer {
  setup (port) {
    this.app = express();

    this.app.use((req, res, next) => {
      if (req.method === 'OPTION') {
        res.writeHead(200, {
          'access-control-allow-origin': '*',
          'access-control-expose-headers': '*',
        });
        res.end('');
      } else {
        console.log(new Date().toLocaleString(), req.method, req.url);
        if (req.url === '/') {
          req.url = '/index';
        }
        next();
      }
    });
    this.app.use('/static', serveStatic(path.join(__dirname, 'web', 'static')));

    const tplCache = {};
    const readTpl = (tplName, cb) => {
      if (!tplCache[tplName]) {
        tplCache[tplName] = new Promise(resolve => {
          fs.readFile(path.join(__dirname, 'web', 'view', tplName + '.ejs'), 'utf-8', (err, content) => {
            if (err) {
              resolve((res, data) => res.end(JSON.stringify(data)));
            } else {
              try {
                const tpl = ejs.compile(content);
                resolve((res, data) => res.end(tpl(data)));
              } catch (err) {
                resolve(res => {
                  res.writeHead(500, {
                    'content-type': 'text/plain; charset=utf-8',
                  });
                  res.end(err.message);
                });
              }
            }
          });
        });
      }
      tplCache[tplName].then(cb);
    };

    this.app.use((req, res, next) => {
      const fpath = req.url.substr(1).replace(/\?.*$/, '');
      try {
        if (process.env.CACHE === 'no') {
          delete require.cache[require.resolve(`./web/action/${fpath}`)];
        }
        const func = wrap(require(`./web/action/${fpath}`));
        res.display = (data, tpl = '') => {
          if (process.env.CACHE === 'no') {
            delete tplCache[tpl];
          }
          readTpl(tpl, template => {
            template(res, data);
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
