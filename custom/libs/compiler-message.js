'use strict';

const TOKEN_OPEN = '\uE000';
const TOKEN_CLOSE = '\uE001';
const ALLOWED_TAG = /<\/?b>|<span\s+style=(['"])color\s*:\s*(#[0-9a-f]{3}(?:[0-9a-f]{3})?)\1\s*>|<\/span>/gi;

function sanitizeCompilerMessage(message) {
  const tags = [];
  const tokenized = String(message == null ? '' : message).replace(ALLOWED_TAG, (tag, quote, color) => {
    let safeTag;
    if (/^<b>$/i.test(tag)) safeTag = '<b>';
    else if (/^<\/b>$/i.test(tag)) safeTag = '</b>';
    else if (/^<\/span>$/i.test(tag)) safeTag = '</span>';
    else safeTag = `<span style="color:${String(color).toUpperCase()}">`;
    const token = TOKEN_OPEN + tags.length + TOKEN_CLOSE;
    tags.push(safeTag);
    return token;
  });

  return tokenized
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(new RegExp(TOKEN_OPEN + '(\\d+)' + TOKEN_CLOSE, 'g'), (_match, index) => tags[Number(index)] || '');
}

module.exports = { sanitizeCompilerMessage };
