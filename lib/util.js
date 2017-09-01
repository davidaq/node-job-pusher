const co = require('co');

function isGenerator(obj) {
  return 'function' == typeof obj.next && 'function' == typeof obj.throw;
}

function isGeneratorFunction(obj) {
  var constructor = obj.constructor;
  if (!constructor) return false;
  if ('GeneratorFunction' === constructor.name || 'GeneratorFunction' === constructor.displayName) return true;
  return isGenerator(constructor.prototype);
}

exports.resolveAsync = (obj) => {
  const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(obj));
  keys.forEach(key => {
    if (isGeneratorFunction(obj[key])) {
      const coFunc = co.wrap(obj[key]);
      obj[key] = function (...args) {
        let errTimeout;
        const promise = coFunc.call(this, ...args).catch(err => {
          errTimeout = setTimeout(() => console.error(err.stack), 50);
          return Promise.reject(err);
        });
        const promiseThen = promise.then;
        promise.then = function (resolve, reject) {
          promiseThen.call(this, resolve, reject);
        };
        promise.catch = function (reject) {
          this.then(null, reject);
        };
      };
    }
  });
};
