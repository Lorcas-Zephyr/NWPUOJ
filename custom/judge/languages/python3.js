"use strict";

const { createPythonLanguage } = require("./_python-modern");

exports.lang = createPythonLanguage("python3", "/usr/bin/python3");
