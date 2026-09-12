"use strict";

const languages = [
    require("./cpp"),
    require("./cpp11"),
    require("./cpp17"),
    require("./cpp20"),
    require("./cpp23"),
    require("./cpp-noilinux"),
    require("./cpp11-noilinux"),
    require("./cpp11-clang"),
    require("./cpp17-clang"),
    require("./c"),
    require("./c-noilinux"),
    require("./csharp"),
    require("./haskell"),
    require("./java"),
    require("./nodejs"),
    require("./pascal"),
    require("./python2"),
    require("./python3"),
    require("./python310"),
    require("./python311"),
    require("./pypy3"),
    require("./ruby")
].map(module => module.lang);

function getLanguage(name) {
    return name == null ? null : languages.find(language => language.name === name);
}

exports.languages = languages;
exports.getLanguage = getLanguage;
