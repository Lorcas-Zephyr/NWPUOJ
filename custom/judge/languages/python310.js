"use strict";

const { createPythonLanguage } = require("./_python-modern");

exports.lang = createPythonLanguage("python310", "/usr/bin/python3.10");
