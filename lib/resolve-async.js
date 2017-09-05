function isGenerator (obj) {
  return 'function' == typeof obj.next && 'function' == typeof obj.throw;
}

function isGeneratorFunction (obj) {
  var constructor = obj.constructor;
  if (!constructor) return false;
  if ('GeneratorFunction' === constructor.name || 'GeneratorFunction' === constructor.displayName) return true;
  return isGenerator(constructor.prototype);
}

function co (iter) {
  return new Promise((resolve, reject) => {
    const next = (err, args) => {
      let done, value;
      try {
        if (err) {
          ({ done, value } = iter.throw(err));
        } else {
          ({ done, value } = iter.next(args));
        }
      } catch (err) {
        reject(err);
        return;
      }
      if (done) {
        resolve(value);
      } else {
        if (typeof value === 'function') {
          value((err, ...args) => next(err, args));
        } else {
          value.then(val => next(null, val), err => next(err));
        }
      }
    };
    setTimeout(next, 30);
  });
}

function wrap (func) {
  return function (...args) {
    const promise = co(func.call(this, ...args));
    let errTimeout;
    promise.catch(err => {
      errTimeout = setTimeout(() => {
        console.error(err.stack);
        process.exit(1);
      }, 50);
    });
    const handler = {
      apply (target, self, args) {
        if (errTimeout) {
          clearTimeout(errTimeout);
          errTimeout = null;
        }
        return target.apply(self, args);
      },
    };
    promise.then = new Proxy(promise.then, handler);
    promise.catch = new Proxy(promise.catch, handler);
    return promise;
  };
}

function resolveAsync (obj) {
  const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(obj));
  keys.forEach(key => {
    if (isGeneratorFunction(obj[key])) {
      obj[key] = wrap(obj[key]);
    }
  });
}

module.exports = { wrap, resolveAsync };
