"use strict";

const { createPythonLanguage } = require("./_python-modern");

exports.lang = createPythonLanguage("python2", "/usr/bin/python2");
