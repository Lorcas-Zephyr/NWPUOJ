(function (window) {
  'use strict';

  function etag(response, body) {
    return response.headers.get('ETag') || body && body.meta && body.meta.etag || '';
  }

  async function request(url, options) {
    var response = await window.fetch(url, Object.assign({ credentials: 'same-origin' }, options || {}));
    var body = await response.json().catch(function () { return null; });
    var result = { response: response, body: body, data: body && body.data, etag: etag(response, body) };
    if (!response.ok) {
      var error = new Error(body && body.error && body.error.message || '请求失败。');
      error.code = body && body.error && body.error.code || 'REQUEST_FAILED';
      error.fields = body && body.error && body.error.fields || {};
      error.status = response.status;
      error.result = result;
      throw error;
    }
    return result;
  }

  function readResource(url, options) {
    return request(url, Object.assign({ cache: 'no-store', headers: { Accept: 'application/json' } }, options || {}));
  }

  function writeResource(url, method, payload, options) {
    var settings = options || {};
    var body = Object.assign({}, payload || {});
    var version = settings.etag || body.if_match || '';
    if (settings.requireEtag && !version) {
      var missing = new Error('资源版本信息缺失，请刷新后重试。');
      missing.code = 'PRECONDITION_REQUIRED';
      return Promise.reject(missing);
    }
    if (version) body.if_match = version;
    var headers = new Headers(settings.headers || { 'Content-Type': 'application/json', Accept: 'application/json' });
    if (version) headers.set('If-Match', version);
    return request(url, Object.assign({}, settings, { method: method || 'POST', headers: headers, body: JSON.stringify(body) }));
  }

  window.NWPUOJApi = { request: request, readResource: readResource, writeResource: writeResource, etag: etag };
})(window);
