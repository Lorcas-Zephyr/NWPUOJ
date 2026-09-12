"use strict";

const { createCppLanguage } = require("./_cpp-modern");

exports.lang = createCppLanguage("cpp23", "c++23", "/usr/bin/g++-14");
