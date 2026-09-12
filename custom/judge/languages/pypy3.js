"use strict";

const { createPythonLanguage } = require("./_python-modern");

exports.lang = createPythonLanguage("pypy3", "/opt/pypy/bin/pypy3");
