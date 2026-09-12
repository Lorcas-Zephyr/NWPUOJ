'use strict';

const TypeORM = require('typeorm');
const { JSDOM } = require('jsdom');

const MENTION_PATTERN = /(^|[^A-Za-z0-9_@-])@([A-Za-z0-9_-]{1,80})(?=$|[^A-Za-z0-9_-])/g;
const MENTION_SKIP_SELECTOR = 'a,code,pre,script,style';
const MENTION_LIMIT = 100;

async function linkUserMentions(html, options = {}) {
  const source = String(html || '');
  if (!source || !source.includes('@')) return source;

  const dom = new JSDOM('<!doctype html><body></body>');
  try {
    const document = dom.window.document;
    document.body.innerHTML = source;
    const textNodes = [];
    const candidateNames = new Map();
    const walker = document.createTreeWalker(document.body, 4);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue || !node.nodeValue.includes('@') || (node.parentElement && node.parentElement.closest(MENTION_SKIP_SELECTOR))) continue;
      textNodes.push(node);
      MENTION_PATTERN.lastIndex = 0;
      let match;
      while ((match = MENTION_PATTERN.exec(node.nodeValue)) && candidateNames.size < MENTION_LIMIT) {
        const name = match[2];
        candidateNames.set(name.toLowerCase(), name);
      }
    }
    if (!candidateNames.size) return source;

    const findUsers = options.findUsers || (names => {
      const User = syzoj.model('user');
      return User.find({ where: { username: TypeORM.In(names) } });
    });
    const users = await findUsers(Array.from(candidateNames.values()));
    const usersByName = new Map((users || []).map(user => [String(user.username || '').toLowerCase(), user]));
    const userUrl = options.userUrl || (user => syzoj.utils.makeUrl(['user', user.id]));
    const userTier = options.userTier || (user => syzoj.utils.calcUserTier ? syzoj.utils.calcUserTier(user) : 'default');

    for (const textNode of textNodes) {
      MENTION_PATTERN.lastIndex = 0;
      let match;
      let cursor = 0;
      let linked = false;
      const fragment = document.createDocumentFragment();
      while ((match = MENTION_PATTERN.exec(textNode.nodeValue))) {
        const user = usersByName.get(match[2].toLowerCase());
        if (!user) continue;
        const mentionStart = match.index + match[1].length;
        fragment.appendChild(document.createTextNode(textNode.nodeValue.slice(cursor, mentionStart)));
        const link = document.createElement('a');
        link.setAttribute('href', userUrl(user));
        link.className = 'app-user-mention username-tier-' + userTier(user);
        link.textContent = '@' + match[2];
        fragment.appendChild(link);
        cursor = MENTION_PATTERN.lastIndex;
        linked = true;
      }
      if (linked) {
        fragment.appendChild(document.createTextNode(textNode.nodeValue.slice(cursor)));
        textNode.parentNode.replaceChild(fragment, textNode);
      }
    }
    return document.body.innerHTML;
  } finally {
    dom.window.close();
  }
}

module.exports = {
  MENTION_LIMIT,
  MENTION_PATTERN,
  MENTION_SKIP_SELECTOR,
  linkUserMentions
};
