'use strict';

const MAX_SIGNATURE_LENGTH = 50;

function validSignature(value) {
  return Array.from(String(value == null ? '' : value)).length <= MAX_SIGNATURE_LENGTH;
}

function installPlainTextSignature(User) {
  // Legacy profile/ranklist routes call this method before rendering. Keep the
  // original text; the EJS views escape it instead of rendering Markdown/HTML.
  User.prototype.renderInformation = async function () {
    this.information = String(this.information == null ? '' : this.information);
  };
}

module.exports = { MAX_SIGNATURE_LENGTH, validSignature, installPlainTextSignature };
