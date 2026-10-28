const renderer = require('syzoj-renderer');
const XSS = require('xss');
const xssWhiteList = Object.assign({}, require('xss/lib/default').whiteList);
delete xssWhiteList.audio;
delete xssWhiteList.video;

for (const tag in xssWhiteList) {
  xssWhiteList[tag] = xssWhiteList[tag].concat(['style', 'class']);
}

const xss = new XSS.FilterXSS({
  whiteList: xssWhiteList,
  stripIgnoreTag: true,
  onTagAttr: (tag, name, value) => {
    if (tag.toLowerCase() === 'img' && name.toLowerCase() === 'src' && value.startsWith('data:image/')) {
      return name + '="' + XSS.escapeAttrValue(value) + '"';
    }
  }
});

const LRUCache = require('lru-cache');
const cache = new LRUCache({ max: parseInt(process.argv[2]) || 1000 });

async function highlight(code, lang) {
  return renderer.highlight(code, lang, cache, { wrapper: null });
}

async function markdown(markdownCode) {
  function filter(html) {
    html = xss.process(html);
    return html ? `<div style="position: relative; overflow: hidden; transform: translate3d(0, 0, 0); ">${html}</div>` : html;
  }
  // Match Vditor's normal Markdown table semantics on every server-rendered
  // surface. Keep the existing math, highlighting, sanitization and cache.
  return renderer.markdown(markdownCode, cache, filter, { markdownItMergeCells: false });
}

process.on('message', async msg => {
  if (msg.type === 'markdown') {
    process.send({ id: msg.id, result: await markdown(msg.source) });
  } else if (msg.type === 'highlight') {
    process.send({ id: msg.id, result: await highlight(msg.source.code, msg.source.lang) });
  }
});

process.on('disconnect', () => process.exit());
