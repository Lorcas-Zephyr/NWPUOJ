const luogu = require("./vjudge/lugou");
const uoj = require("./vjudge/uoj");
const hdu = require("./vjudge/hdu");
const poj = require("./vjudge/poj");

module.exports = function vjudge(judge_state, problem, onProgress) {
  if (problem.type === "vjudge:luogu") return luogu(judge_state, problem, onProgress);
  if (problem.type === "vjudge:uoj") return uoj(judge_state, problem, onProgress);
  if (problem.type === "vjudge:hdu") return hdu(judge_state, problem, onProgress);
  if (problem.type === "vjudge:poj") return poj(judge_state, problem, onProgress);
  throw new Error("Unsupported VJudge provider: " + problem.type);
};

module.exports.languages = {
  luogu: luogu.languages,
  uoj: uoj.languages,
  hdu: hdu.languages,
  poj: poj.languages
};
