"use strict";

const { createPythonLanguage } = require("./_python-modern");

exports.lang = createPythonLanguage("python311", "/usr/bin/python3.11");
