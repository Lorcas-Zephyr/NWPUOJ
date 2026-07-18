"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
exports.__esModule = true;
var TypeORM = require("typeorm");
var common_1 = require("./common");
var user_1 = require("./user");
var file_1 = require("./file");
var judge_state_1 = require("./judge_state");
var contest_1 = require("./contest");
var problem_tag_1 = require("./problem_tag");
var problem_tag_map_1 = require("./problem_tag_map");
var submission_statistics_1 = require("./submission_statistics");
var fs = require("fs-extra");
var path = require("path");
var util = require("util");
var LRUCache = require("lru-cache");
var DeepCopy = require("deepcopy");
var problemTagCache = new LRUCache({
    max: syzoj.config.db.cache_size
});
var ProblemType;
(function (ProblemType) {
    ProblemType["Traditional"] = "traditional";
    ProblemType["SubmitAnswer"] = "submit-answer";
    ProblemType["Interaction"] = "interaction";
    ProblemType["VJudge_Luogu"] = "vjudge:luogu";
    ProblemType["VJudge_UOJ"] = "vjudge:uoj";
    ProblemType["VJudge_HDU"] = "vjudge:hdu";
    ProblemType["VJudge_POJ"] = "vjudge:poj";
})(ProblemType || (ProblemType = {}));
var statisticsTypes = {
    fastest: ['total_time', 'ASC'],
    slowest: ['total_time', 'DESC'],
    shortest: ['code_length', 'ASC'],
    longest: ['code_length', 'DESC'],
    min: ['max_memory', 'ASC'],
    max: ['max_memory', 'DESC'],
    earliest: ['submit_time', 'ASC']
};
var statisticsCodeOnly = ["fastest", "slowest", "min", "max"];
var Problem = /** @class */ (function (_super) {
    __extends(Problem, _super);
    function Problem() {
        return _super !== null && _super.apply(this, arguments) || this;
    }
    Problem_1 = Problem;
    Problem.prototype.loadRelationships = function () {
        return __awaiter(this, void 0, void 0, function () {
            var _a, _b, _c;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        _a = this;
                        return [4 /*yield*/, user_1["default"].findById(this.user_id)];
                    case 1:
                        _a.user = _d.sent();
                        _b = this;
                        return [4 /*yield*/, user_1["default"].findById(this.publicizer_id)];
                    case 2:
                        _b.publicizer = _d.sent();
                        _c = this;
                        return [4 /*yield*/, file_1["default"].findById(this.additional_file_id)];
                    case 3:
                        _c.additional_file = _d.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    Problem.prototype.isAllowedEditBy = function (user) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!user)
                            return [2 /*return*/, false];
                        return [4 /*yield*/, user.hasPrivilege('manage_problem')];
                    case 1:
                        if (_a.sent())
                            return [2 /*return*/, true];
                        return [2 /*return*/, this.user_id === user.id];
                }
            });
        });
    };
    Problem.prototype.isAllowedUseBy = function (user) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (this.is_public)
                            return [2 /*return*/, true];
                        if (!user)
                            return [2 /*return*/, false];
                        return [4 /*yield*/, user.hasPrivilege('manage_problem')];
                    case 1:
                        if (_a.sent())
                            return [2 /*return*/, true];
                        return [2 /*return*/, this.user_id === user.id];
                }
            });
        });
    };
    Problem.prototype.isAllowedManageBy = function (user) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!user)
                            return [2 /*return*/, false];
                        return [4 /*yield*/, user.hasPrivilege('manage_problem')];
                    case 1:
                        if (_a.sent())
                            return [2 /*return*/, true];
                        return [2 /*return*/, user.is_admin];
                }
            });
        });
    };
    Problem.prototype.getTestdataPath = function () {
        return syzoj.utils.resolvePath(syzoj.config.upload_dir, 'testdata', this.id.toString());
    };
    Problem.prototype.getTestdataArchivePath = function () {
        return syzoj.utils.resolvePath(syzoj.config.upload_dir, 'testdata-archive', this.id.toString() + '.zip');
    };
    Problem.prototype.updateTestdata = function (path, noLimit) {
        return __awaiter(this, void 0, void 0, function () {
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, syzoj.utils.lock(['Problem::Testdata', this.id], function () { return __awaiter(_this, void 0, void 0, function () {
                            var unzipSize, unzipCount, p7zip, dir, execFileAsync;
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0:
                                        unzipSize = 0, unzipCount = 0;
                                        p7zip = new (require('node-7z'));
                                        return [4 /*yield*/, p7zip.list(path).progress(function (files) {
                                                unzipCount += files.length;
                                                for (var _i = 0, files_1 = files; _i < files_1.length; _i++) {
                                                    var file = files_1[_i];
                                                    unzipSize += file.size;
                                                }
                                            })];
                                    case 1:
                                        _a.sent();
                                        if (!noLimit && unzipCount > syzoj.config.limit.testdata_filecount)
                                            throw new ErrorMessage('数据包中的文件太多。');
                                        if (!noLimit && unzipSize > syzoj.config.limit.testdata)
                                            throw new ErrorMessage('数据包太大。');
                                        dir = this.getTestdataPath();
                                        return [4 /*yield*/, fs.remove(dir)];
                                    case 2:
                                        _a.sent();
                                        return [4 /*yield*/, fs.ensureDir(dir)];
                                    case 3:
                                        _a.sent();
                                        execFileAsync = util.promisify(require('child_process').execFile);
                                        return [4 /*yield*/, execFileAsync(__dirname + '/../bin/unzip', ['-j', '-o', '-d', dir, path])];
                                    case 4:
                                        _a.sent();
                                        return [4 /*yield*/, fs.move(path, this.getTestdataArchivePath(), { overwrite: true })];
                                    case 5:
                                        _a.sent();
                                        return [2 /*return*/];
                                }
                            });
                        }); })];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    Problem.prototype.uploadTestdataSingleFile = function (filename, filepath, size, noLimit) {
        return __awaiter(this, void 0, void 0, function () {
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, syzoj.utils.lock(['Promise::Testdata', this.id], function () { return __awaiter(_this, void 0, void 0, function () {
                            var dir, oldSize, list, replace, oldCount, _i, _a, file, execFileAsync, e_1;
                            return __generator(this, function (_b) {
                                switch (_b.label) {
                                    case 0:
                                        dir = this.getTestdataPath();
                                        return [4 /*yield*/, fs.ensureDir(dir)];
                                    case 1:
                                        _b.sent();
                                        oldSize = 0;
                                        return [4 /*yield*/, this.listTestdata()];
                                    case 2:
                                        list = _b.sent(), replace = false, oldCount = 0;
                                        if (list) {
                                            oldCount = list.files.length;
                                            for (_i = 0, _a = list.files; _i < _a.length; _i++) {
                                                file = _a[_i];
                                                if (file.filename !== filename)
                                                    oldSize += file.size;
                                                else
                                                    replace = true;
                                            }
                                        }
                                        if (!noLimit && oldSize + size > syzoj.config.limit.testdata)
                                            throw new ErrorMessage('数据包太大。');
                                        if (!noLimit && oldCount + !replace > syzoj.config.limit.testdata_filecount)
                                            throw new ErrorMessage('数据包中的文件太多。');
                                        return [4 /*yield*/, fs.move(filepath, path.join(dir, filename), { overwrite: true })];
                                    case 3:
                                        _b.sent();
                                        execFileAsync = util.promisify(require('child_process').execFile);
                                        _b.label = 4;
                                    case 4:
                                        _b.trys.push([4, 6, , 7]);
                                        return [4 /*yield*/, execFileAsync('dos2unix', [path.join(dir, filename)])];
                                    case 5:
                                        _b.sent();
                                        return [3 /*break*/, 7];
                                    case 6:
                                        e_1 = _b.sent();
                                        return [3 /*break*/, 7];
                                    case 7: return [4 /*yield*/, fs.remove(this.getTestdataArchivePath())];
                                    case 8:
                                        _b.sent();
                                        return [2 /*return*/];
                                }
                            });
                        }); })];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    Problem.prototype.deleteTestdataSingleFile = function (filename) {
        return __awaiter(this, void 0, void 0, function () {
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, syzoj.utils.lock(['Promise::Testdata', this.id], function () { return __awaiter(_this, void 0, void 0, function () {
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0: return [4 /*yield*/, fs.remove(path.join(this.getTestdataPath(), filename))];
                                    case 1:
                                        _a.sent();
                                        return [4 /*yield*/, fs.remove(this.getTestdataArchivePath())];
                                    case 2:
                                        _a.sent();
                                        return [2 /*return*/];
                                }
                            });
                        }); })];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    Problem.prototype.makeTestdataZip = function () {
        return __awaiter(this, void 0, void 0, function () {
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, syzoj.utils.lock(['Promise::Testdata', this.id], function () { return __awaiter(_this, void 0, void 0, function () {
                            var dir, p7zip, list, pathlist;
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0:
                                        dir = this.getTestdataPath();
                                        return [4 /*yield*/, syzoj.utils.isDir(dir)];
                                    case 1:
                                        if (!(_a.sent()))
                                            throw new ErrorMessage('无测试数据。');
                                        p7zip = new (require('node-7z'));
                                        return [4 /*yield*/, this.listTestdata()];
                                    case 2:
                                        list = _a.sent(), pathlist = list.files.map(function (file) { return path.join(dir, file.filename); });
                                        if (!pathlist.length)
                                            throw new ErrorMessage('无测试数据。');
                                        return [4 /*yield*/, fs.ensureDir(path.resolve(this.getTestdataArchivePath(), '..'))];
                                    case 3:
                                        _a.sent();
                                        return [4 /*yield*/, p7zip.add(this.getTestdataArchivePath(), pathlist)];
                                    case 4:
                                        _a.sent();
                                        return [2 /*return*/];
                                }
                            });
                        }); })];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    Problem.prototype.hasSpecialJudge = function () {
        return __awaiter(this, void 0, void 0, function () {
            var dir, list, e_2;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        dir = this.getTestdataPath();
                        return [4 /*yield*/, fs.readdir(dir)];
                    case 1:
                        list = _a.sent();
                        return [2 /*return*/, list.includes('spj.js') || list.find(function (x) { return x.startsWith('spj_'); }) !== undefined];
                    case 2:
                        e_2 = _a.sent();
                        return [2 /*return*/, false];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    Problem.prototype.listTestdata = function () {
        return __awaiter(this, void 0, void 0, function () {
            var dir_1, filenameList, list, res, stat, e_3, e_4;
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 7, , 8]);
                        dir_1 = this.getTestdataPath();
                        return [4 /*yield*/, fs.readdir(dir_1)];
                    case 1:
                        filenameList = _a.sent();
                        return [4 /*yield*/, Promise.all(filenameList.map(function (x) { return __awaiter(_this, void 0, void 0, function () {
                                var stat;
                                return __generator(this, function (_a) {
                                    switch (_a.label) {
                                        case 0: return [4 /*yield*/, fs.stat(path.join(dir_1, x))];
                                        case 1:
                                            stat = _a.sent();
                                            if (!stat.isFile())
                                                return [2 /*return*/, undefined];
                                            return [2 /*return*/, {
                                                    filename: x,
                                                    size: stat.size
                                                }];
                                    }
                                });
                            }); }))];
                    case 2:
                        list = _a.sent();
                        list = list.filter(function (x) { return x; });
                        res = {
                            files: list,
                            zip: null
                        };
                        _a.label = 3;
                    case 3:
                        _a.trys.push([3, 5, , 6]);
                        return [4 /*yield*/, fs.stat(this.getTestdataArchivePath())];
                    case 4:
                        stat = _a.sent();
                        if (stat.isFile()) {
                            res.zip = {
                                size: stat.size
                            };
                        }
                        return [3 /*break*/, 6];
                    case 5:
                        e_3 = _a.sent();
                        if (list) {
                            res.zip = {
                                size: null
                            };
                        }
                        return [3 /*break*/, 6];
                    case 6: return [2 /*return*/, res];
                    case 7:
                        e_4 = _a.sent();
                        return [2 /*return*/, null];
                    case 8: return [2 /*return*/];
                }
            });
        });
    };
    Problem.prototype.updateFile = function (path, type, noLimit) {
        return __awaiter(this, void 0, void 0, function () {
            var file;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, file_1["default"].upload(path, type, noLimit)];
                    case 1:
                        file = _a.sent();
                        if (type === 'additional_file') {
                            this.additional_file_id = file.id;
                        }
                        return [4 /*yield*/, this.save()];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    Problem.prototype.validate = function () {
        return __awaiter(this, void 0, void 0, function () {
            var filenameRE;
            return __generator(this, function (_a) {
                if (this.time_limit <= 0)
                    return [2 /*return*/, 'Invalid time limit'];
                if (this.time_limit > syzoj.config.limit.time_limit)
                    return [2 /*return*/, 'Time limit too large'];
                if (this.memory_limit <= 0)
                    return [2 /*return*/, 'Invalid memory limit'];
                if (this.memory_limit > syzoj.config.limit.memory_limit)
                    return [2 /*return*/, 'Memory limit too large'];
                if (!Object.values(ProblemType).includes(this.type))
                    return [2 /*return*/, 'Invalid problem type'];
                if (this.type === 'traditional') {
                    filenameRE = /^[\w \-\+\.]*$/;
                    if (this.file_io_input_name && !filenameRE.test(this.file_io_input_name))
                        return [2 /*return*/, 'Invalid input file name'];
                    if (this.file_io_output_name && !filenameRE.test(this.file_io_output_name))
                        return [2 /*return*/, 'Invalid output file name'];
                    if (this.file_io) {
                        if (!this.file_io_input_name)
                            return [2 /*return*/, 'No input file name'];
                        if (!this.file_io_output_name)
                            return [2 /*return*/, 'No output file name'];
                    }
                }
                return [2 /*return*/, null];
            });
        });
    };
    Problem.prototype.getJudgeState = function (user, acFirst) {
        return __awaiter(this, void 0, void 0, function () {
            var where, state;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!user)
                            return [2 /*return*/, null];
                        where = {
                            user_id: user.id,
                            problem_id: this.id
                        };
                        if (!acFirst) return [3 /*break*/, 2];
                        where.status = 'Accepted';
                        return [4 /*yield*/, judge_state_1["default"].findOne({
                                where: where,
                                order: {
                                    submit_time: 'DESC'
                                }
                            })];
                    case 1:
                        state = _a.sent();
                        if (state)
                            return [2 /*return*/, state];
                        _a.label = 2;
                    case 2:
                        if (where.status)
                            delete where.status;
                        return [4 /*yield*/, judge_state_1["default"].findOne({
                                where: where,
                                order: {
                                    submit_time: 'DESC'
                                }
                            })];
                    case 3: return [2 /*return*/, _a.sent()];
                }
            });
        });
    };
    Problem.prototype.resetSubmissionCount = function () {
        return __awaiter(this, void 0, void 0, function () {
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, syzoj.utils.lock(['Problem::resetSubmissionCount', this.id], function () { return __awaiter(_this, void 0, void 0, function () {
                            var _a, _b;
                            return __generator(this, function (_c) {
                                switch (_c.label) {
                                    case 0:
                                        _a = this;
                                        return [4 /*yield*/, judge_state_1["default"].count({ problem_id: this.id, type: TypeORM.Not(1) })];
                                    case 1:
                                        _a.submit_num = _c.sent();
                                        _b = this;
                                        return [4 /*yield*/, judge_state_1["default"].count({ score: 100, problem_id: this.id, type: TypeORM.Not(1) })];
                                    case 2:
                                        _b.ac_num = _c.sent();
                                        return [4 /*yield*/, this.save()];
                                    case 3:
                                        _c.sent();
                                        return [2 /*return*/];
                                }
                            });
                        }); })];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    Problem.prototype.updateStatistics = function (user_id) {
        return __awaiter(this, void 0, void 0, function () {
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, Promise.all(Object.keys(statisticsTypes).map(function (type) { return __awaiter(_this, void 0, void 0, function () {
                            var _this = this;
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0:
                                        if (this.type === ProblemType.SubmitAnswer && statisticsCodeOnly.includes(type))
                                            return [2 /*return*/];
                                        return [4 /*yield*/, syzoj.utils.lock(['Problem::UpdateStatistics', this.id, type], function () { return __awaiter(_this, void 0, void 0, function () {
                                                var _a, _b, column, order, result, resultRow, toDelete, baseColumns, record;
                                                return __generator(this, function (_c) {
                                                    switch (_c.label) {
                                                        case 0:
                                                            _b = statisticsTypes[type], column = _b[0], order = _b[1];
                                                            return [4 /*yield*/, judge_state_1["default"].createQueryBuilder()
                                                                    .select([column, "id"])
                                                                    .where("user_id = :user_id", { user_id: user_id })
                                                                    .andWhere("status = :status", { status: "Accepted" })
                                                                    .andWhere("problem_id = :problem_id", { problem_id: this.id })
                                                                    .orderBy((_a = {}, _a[column] = order, _a))
                                                                    .take(1)
                                                                    .getRawMany()];
                                                        case 1:
                                                            result = _c.sent();
                                                            resultRow = result[0];
                                                            toDelete = false;
                                                            if (!resultRow || resultRow[column] == null) {
                                                                toDelete = true;
                                                            }
                                                            baseColumns = {
                                                                user_id: user_id,
                                                                problem_id: this.id,
                                                                type: type
                                                            };
                                                            return [4 /*yield*/, submission_statistics_1["default"].findOne(baseColumns)];
                                                        case 2:
                                                            record = _c.sent();
                                                            if (!toDelete) return [3 /*break*/, 5];
                                                            if (!record) return [3 /*break*/, 4];
                                                            return [4 /*yield*/, record.destroy()];
                                                        case 3:
                                                            _c.sent();
                                                            _c.label = 4;
                                                        case 4: return [2 /*return*/];
                                                        case 5:
                                                            if (!record) {
                                                                record = submission_statistics_1["default"].create(baseColumns);
                                                            }
                                                            record.key = resultRow[column];
                                                            record.submission_id = resultRow["id"];
                                                            return [4 /*yield*/, record.save()];
                                                        case 6:
                                                            _c.sent();
                                                            return [2 /*return*/];
                                                    }
                                                });
                                            }); })];
                                    case 1:
                                        _a.sent();
                                        return [2 /*return*/];
                                }
                            });
                        }); }))];
                    case 1:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    Problem.prototype.countStatistics = function (type) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!statisticsTypes[type] || this.type === ProblemType.SubmitAnswer && statisticsCodeOnly.includes(type)) {
                            return [2 /*return*/, null];
                        }
                        return [4 /*yield*/, submission_statistics_1["default"].count({
                                problem_id: this.id,
                                type: type
                            })];
                    case 1: return [2 /*return*/, _a.sent()];
                }
            });
        });
    };
    Problem.prototype.getStatistics = function (type, paginate) {
        return __awaiter(this, void 0, void 0, function () {
            var statistics, order, ids, _a, _b, a, scoreCount, _i, a_1, score, i, i, i;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        if (!statisticsTypes[type] || this.type === ProblemType.SubmitAnswer && statisticsCodeOnly.includes(type)) {
                            return [2 /*return*/, null];
                        }
                        statistics = {
                            type: type,
                            judge_state: null,
                            scoreDistribution: null,
                            prefixSum: null,
                            suffixSum: null
                        };
                        order = statisticsTypes[type][1];
                        return [4 /*yield*/, submission_statistics_1["default"].queryPage(paginate, {
                                problem_id: this.id,
                                type: type
                            }, {
                                '`key`': order
                            })];
                    case 1:
                        ids = (_c.sent()).map(function (x) { return x.submission_id; });
                        _a = statistics;
                        if (!ids.length) return [3 /*break*/, 3];
                        return [4 /*yield*/, judge_state_1["default"].createQueryBuilder()
                                .whereInIds(ids)
                                .orderBy("FIELD(id," + ids.join(',') + ")")
                                .getMany()];
                    case 2:
                        _b = _c.sent();
                        return [3 /*break*/, 4];
                    case 3:
                        _b = [];
                        _c.label = 4;
                    case 4:
                        _a.judge_state = _b;
                        return [4 /*yield*/, judge_state_1["default"].createQueryBuilder()
                                .select('score')
                                .addSelect('COUNT(*)', 'count')
                                .where('problem_id = :problem_id', { problem_id: this.id })
                                .andWhere('type = 0')
                                .andWhere('pending = false')
                                .groupBy('score')
                                .getRawMany()];
                    case 5:
                        a = _c.sent();
                        scoreCount = [];
                        for (_i = 0, a_1 = a; _i < a_1.length; _i++) {
                            score = a_1[_i];
                            score.score = Math.min(Math.round(score.score), 100);
                            scoreCount[score.score] = score.count;
                        }
                        if (scoreCount[0] === undefined)
                            scoreCount[0] = 0;
                        if (scoreCount[100] === undefined)
                            scoreCount[100] = 0;
                        if (a[null]) {
                            a[0] += a[null];
                            delete a[null];
                        }
                        statistics.scoreDistribution = [];
                        for (i = 0; i < scoreCount.length; i++) {
                            if (scoreCount[i] !== undefined)
                                statistics.scoreDistribution.push({ score: i, count: parseInt(scoreCount[i]) });
                        }
                        statistics.prefixSum = DeepCopy(statistics.scoreDistribution);
                        statistics.suffixSum = DeepCopy(statistics.scoreDistribution);
                        for (i = 1; i < statistics.prefixSum.length; i++) {
                            statistics.prefixSum[i].count += statistics.prefixSum[i - 1].count;
                        }
                        for (i = statistics.prefixSum.length - 1; i >= 1; i--) {
                            statistics.suffixSum[i - 1].count += statistics.suffixSum[i].count;
                        }
                        return [2 /*return*/, statistics];
                }
            });
        });
    };
    Problem.prototype.getTags = function () {
        return __awaiter(this, void 0, void 0, function () {
            var tagIDs, maps, res;
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!problemTagCache.has(this.id)) return [3 /*break*/, 1];
                        tagIDs = problemTagCache.get(this.id);
                        return [3 /*break*/, 3];
                    case 1: return [4 /*yield*/, problem_tag_map_1["default"].find({
                            where: {
                                problem_id: this.id
                            }
                        })];
                    case 2:
                        maps = _a.sent();
                        tagIDs = maps.map(function (x) { return x.tag_id; });
                        problemTagCache.set(this.id, tagIDs);
                        _a.label = 3;
                    case 3: return [4 /*yield*/, tagIDs.mapAsync(function (tagID) { return __awaiter(_this, void 0, void 0, function () {
                            return __generator(this, function (_a) {
                                return [2 /*return*/, problem_tag_1["default"].findById(tagID)];
                            });
                        }); })];
                    case 4:
                        res = _a.sent();
                        res.sort(function (a, b) {
                            return a.color > b.color ? 1 : -1;
                        });
                        return [2 /*return*/, res];
                }
            });
        });
    };
    Problem.prototype.setTags = function (newTagIDs) {
        return __awaiter(this, void 0, void 0, function () {
            var oldTagIDs, delTagIDs, addTagIDs, _i, delTagIDs_1, tagID, map, _a, addTagIDs_1, tagID, map;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0: return [4 /*yield*/, this.getTags()];
                    case 1:
                        oldTagIDs = (_b.sent()).map(function (x) { return x.id; });
                        delTagIDs = oldTagIDs.filter(function (x) { return !newTagIDs.includes(x); });
                        addTagIDs = newTagIDs.filter(function (x) { return !oldTagIDs.includes(x); });
                        _i = 0, delTagIDs_1 = delTagIDs;
                        _b.label = 2;
                    case 2:
                        if (!(_i < delTagIDs_1.length)) return [3 /*break*/, 6];
                        tagID = delTagIDs_1[_i];
                        return [4 /*yield*/, problem_tag_map_1["default"].findOne({
                                where: {
                                    problem_id: this.id,
                                    tag_id: tagID
                                }
                            })];
                    case 3:
                        map = _b.sent();
                        return [4 /*yield*/, map.destroy()];
                    case 4:
                        _b.sent();
                        _b.label = 5;
                    case 5:
                        _i++;
                        return [3 /*break*/, 2];
                    case 6:
                        _a = 0, addTagIDs_1 = addTagIDs;
                        _b.label = 7;
                    case 7:
                        if (!(_a < addTagIDs_1.length)) return [3 /*break*/, 11];
                        tagID = addTagIDs_1[_a];
                        return [4 /*yield*/, problem_tag_map_1["default"].create({
                                problem_id: this.id,
                                tag_id: tagID
                            })];
                    case 8:
                        map = _b.sent();
                        return [4 /*yield*/, map.save()];
                    case 9:
                        _b.sent();
                        _b.label = 10;
                    case 10:
                        _a++;
                        return [3 /*break*/, 7];
                    case 11:
                        problemTagCache.set(this.id, newTagIDs);
                        return [2 /*return*/];
                }
            });
        });
    };
    Problem.prototype.changeID = function (id) {
        return __awaiter(this, void 0, void 0, function () {
            var entityManager, contests, _i, contests_1, contest, problemIDs, flag, i, oldTestdataDir, oldTestdataZip, oldID, newTestdataDir, newTestdataZip;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        entityManager = TypeORM.getManager();
                        id = parseInt(id);
                        return [4 /*yield*/, entityManager.query('UPDATE `problem`               SET `id`         = ' + id + ' WHERE `id`         = ' + this.id)];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, entityManager.query('UPDATE `judge_state`           SET `problem_id` = ' + id + ' WHERE `problem_id` = ' + this.id)];
                    case 2:
                        _a.sent();
                        return [4 /*yield*/, entityManager.query('UPDATE `problem_tag_map`       SET `problem_id` = ' + id + ' WHERE `problem_id` = ' + this.id)];
                    case 3:
                        _a.sent();
                        return [4 /*yield*/, entityManager.query('UPDATE `article`               SET `problem_id` = ' + id + ' WHERE `problem_id` = ' + this.id)];
                    case 4:
                        _a.sent();
                        return [4 /*yield*/, entityManager.query('UPDATE `submission_statistics` SET `problem_id` = ' + id + ' WHERE `problem_id` = ' + this.id)];
                    case 5:
                        _a.sent();
                        return [4 /*yield*/, contest_1["default"].find()];
                    case 6:
                        contests = _a.sent();
                        _i = 0, contests_1 = contests;
                        _a.label = 7;
                    case 7:
                        if (!(_i < contests_1.length)) return [3 /*break*/, 12];
                        contest = contests_1[_i];
                        return [4 /*yield*/, contest.getProblems()];
                    case 8:
                        problemIDs = _a.sent();
                        flag = false;
                        for (i in problemIDs) {
                            if (problemIDs[i] === this.id) {
                                problemIDs[i] = id;
                                flag = true;
                            }
                        }
                        if (!flag) return [3 /*break*/, 11];
                        return [4 /*yield*/, contest.setProblemsNoCheck(problemIDs)];
                    case 9:
                        _a.sent();
                        return [4 /*yield*/, contest.save()];
                    case 10:
                        _a.sent();
                        _a.label = 11;
                    case 11:
                        _i++;
                        return [3 /*break*/, 7];
                    case 12:
                        oldTestdataDir = this.getTestdataPath(), oldTestdataZip = this.getTestdataArchivePath();
                        oldID = this.id;
                        this.id = id;
                        newTestdataDir = this.getTestdataPath(), newTestdataZip = this.getTestdataArchivePath();
                        return [4 /*yield*/, syzoj.utils.isDir(oldTestdataDir)];
                    case 13:
                        if (!_a.sent()) return [3 /*break*/, 15];
                        return [4 /*yield*/, fs.move(oldTestdataDir, newTestdataDir)];
                    case 14:
                        _a.sent();
                        _a.label = 15;
                    case 15: return [4 /*yield*/, syzoj.utils.isFile(oldTestdataZip)];
                    case 16:
                        if (!_a.sent()) return [3 /*break*/, 18];
                        return [4 /*yield*/, fs.move(oldTestdataZip, newTestdataZip)];
                    case 17:
                        _a.sent();
                        _a.label = 18;
                    case 18: return [4 /*yield*/, this.save()];
                    case 19:
                        _a.sent();
                        return [4 /*yield*/, Problem_1.deleteFromCache(oldID)];
                    case 20:
                        _a.sent();
                        return [4 /*yield*/, problemTagCache.del(oldID)];
                    case 21:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    Problem.prototype["delete"] = function () {
        return __awaiter(this, void 0, void 0, function () {
            var entityManager, oldTestdataDir, oldTestdataZip, submissions, submitCnt, acUsers, _i, submissions_1, sm, _a, _b, _c, u, user;
            return __generator(this, function (_d) {
                switch (_d.label) {
                    case 0:
                        entityManager = TypeORM.getManager();
                        oldTestdataDir = this.getTestdataPath(), oldTestdataZip = this.getTestdataArchivePath();
                        return [4 /*yield*/, fs.remove(oldTestdataDir)];
                    case 1:
                        _d.sent();
                        return [4 /*yield*/, fs.remove(oldTestdataZip)];
                    case 2:
                        _d.sent();
                        return [4 /*yield*/, judge_state_1["default"].find({
                                where: {
                                    problem_id: this.id
                                }
                            })];
                    case 3:
                        submissions = _d.sent(), submitCnt = {}, acUsers = new Set();
                        for (_i = 0, submissions_1 = submissions; _i < submissions_1.length; _i++) {
                            sm = submissions_1[_i];
                            if (sm.status === 'Accepted')
                                acUsers.add(sm.user_id);
                            if (!submitCnt[sm.user_id]) {
                                submitCnt[sm.user_id] = 1;
                            }
                            else {
                                submitCnt[sm.user_id]++;
                            }
                        }
                        _a = [];
                        for (_b in submitCnt)
                            _a.push(_b);
                        _c = 0;
                        _d.label = 4;
                    case 4:
                        if (!(_c < _a.length)) return [3 /*break*/, 8];
                        u = _a[_c];
                        return [4 /*yield*/, user_1["default"].findById(parseInt(u))];
                    case 5:
                        user = _d.sent();
                        user.submit_num -= submitCnt[u];
                        if (acUsers.has(parseInt(u)))
                            user.ac_num--;
                        return [4 /*yield*/, user.save()];
                    case 6:
                        _d.sent();
                        _d.label = 7;
                    case 7:
                        _c++;
                        return [3 /*break*/, 4];
                    case 8:
                        problemTagCache.del(this.id);
                        return [4 /*yield*/, Promise.all([
                                entityManager.query('DELETE FROM `judge_state_admin_action` WHERE `affected_problem_id` = ' + this.id),
                                entityManager.query('DELETE FROM `article_comment` WHERE `article_id` IN (SELECT `id` FROM `article` WHERE `problem_id` = ' + this.id + ')'),
                                entityManager.query('DELETE `comment`, `solution` FROM `problem_solution` AS `solution` LEFT JOIN `problem_solution_comment` AS `comment` ON `comment`.`solution_id` = `solution`.`id` WHERE `solution`.`problem_id` = ' + this.id),
                                entityManager.query('DELETE FROM `problem_solution_setting` WHERE `problem_id` = ' + this.id),
                                entityManager.query("UPDATE `ticket` SET `relation_id` = NULL WHERE `relation_type` = 'problem' AND `relation_id` = " + this.id)
                            ])];
                    case 9:
                        _d.sent();
                        return [4 /*yield*/, entityManager.query('DELETE FROM `judge_state`           WHERE `problem_id` = ' + this.id)];
                    case 10:
                        _d.sent();
                        return [4 /*yield*/, entityManager.query('DELETE FROM `problem_tag_map`       WHERE `problem_id` = ' + this.id)];
                    case 11:
                        _d.sent();
                        return [4 /*yield*/, entityManager.query('DELETE FROM `article`               WHERE `problem_id` = ' + this.id)];
                    case 12:
                        _d.sent();
                        return [4 /*yield*/, entityManager.query('DELETE FROM `submission_statistics` WHERE `problem_id` = ' + this.id)];
                    case 13:
                        _d.sent();
                        return [4 /*yield*/, this.destroy()];
                    case 14:
                        _d.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    Problem.prototype.getDisplayId = function () {
        if (this.type === ProblemType.VJudge_UOJ && /^\d+$/.test(this.vjudge_config || '')) {
            return "U" + this.vjudge_config;
        }
        if (this.type === ProblemType.VJudge_HDU && /^\d+$/.test(this.vjudge_config || '')) {
            return "H" + this.vjudge_config;
        }
        if (this.type === ProblemType.VJudge_POJ && /^\d+$/.test(this.vjudge_config || '')) {
            return "P" + this.vjudge_config;
        }
        return "#" + this.id;
    };
    Problem.prototype.getVJudgeLanguages = function () {
        var vjudge = typeof this.type === 'string' && this.type.startsWith('vjudge:') ? this.type.split(':')[1] : null;
        return vjudge ? require("../libs/vjudge").languages[vjudge] : null;
    };
    var Problem_1;
    Problem.cache = true;
    __decorate([
        TypeORM.PrimaryGeneratedColumn(),
        __metadata("design:type", Number)
    ], Problem.prototype, "id");
    __decorate([
        TypeORM.Column({ nullable: true, type: "varchar", length: 80 }),
        __metadata("design:type", String)
    ], Problem.prototype, "title");
    __decorate([
        TypeORM.Index(),
        TypeORM.Column({ nullable: true, type: "integer" }),
        __metadata("design:type", Number)
    ], Problem.prototype, "user_id");
    __decorate([
        TypeORM.Column({ nullable: true, type: "integer" }),
        __metadata("design:type", Number)
    ], Problem.prototype, "publicizer_id");
    __decorate([
        TypeORM.Column({ nullable: true, type: "boolean" }),
        __metadata("design:type", Boolean)
    ], Problem.prototype, "is_anonymous");
    __decorate([
        TypeORM.Column({ nullable: true, type: "text" }),
        __metadata("design:type", String)
    ], Problem.prototype, "description");
    __decorate([
        TypeORM.Column({ nullable: true, type: "text" }),
        __metadata("design:type", String)
    ], Problem.prototype, "input_format");
    __decorate([
        TypeORM.Column({ nullable: true, type: "text" }),
        __metadata("design:type", String)
    ], Problem.prototype, "output_format");
    __decorate([
        TypeORM.Column({ nullable: true, type: "text" }),
        __metadata("design:type", String)
    ], Problem.prototype, "example");
    __decorate([
        TypeORM.Column({ nullable: true, type: "text" }),
        __metadata("design:type", String)
    ], Problem.prototype, "limit_and_hint");
    __decorate([
        TypeORM.Column({ nullable: true, type: "integer" }),
        __metadata("design:type", Number)
    ], Problem.prototype, "time_limit");
    __decorate([
        TypeORM.Column({ nullable: true, type: "integer" }),
        __metadata("design:type", Number)
    ], Problem.prototype, "memory_limit");
    __decorate([
        TypeORM.Column({ nullable: true, type: "integer" }),
        __metadata("design:type", Number)
    ], Problem.prototype, "additional_file_id");
    __decorate([
        TypeORM.Column({ nullable: true, type: "integer" }),
        __metadata("design:type", Number)
    ], Problem.prototype, "ac_num");
    __decorate([
        TypeORM.Column({ nullable: true, type: "integer" }),
        __metadata("design:type", Number)
    ], Problem.prototype, "submit_num");
    __decorate([
        TypeORM.Index(),
        TypeORM.Column({ nullable: true, type: "boolean" }),
        __metadata("design:type", Boolean)
    ], Problem.prototype, "is_public");
    __decorate([
        TypeORM.Column({ nullable: true, type: "boolean" }),
        __metadata("design:type", Boolean)
    ], Problem.prototype, "file_io");
    __decorate([
        TypeORM.Column({ nullable: true, type: "text" }),
        __metadata("design:type", String)
    ], Problem.prototype, "file_io_input_name");
    __decorate([
        TypeORM.Column({ nullable: true, type: "text" }),
        __metadata("design:type", String)
    ], Problem.prototype, "file_io_output_name");
    __decorate([
        TypeORM.Index(),
        TypeORM.Column({ nullable: true, type: "datetime" }),
        __metadata("design:type", Date)
    ], Problem.prototype, "publicize_time");
    __decorate([
        TypeORM.Column({ nullable: true,
            type: "enum",
            "enum": ProblemType,
            "default": ProblemType.Traditional
        }),
        __metadata("design:type", String)
    ], Problem.prototype, "type");
    __decorate([
        TypeORM.Column({ nullable: true, type: "varchar", length: 80 }),
        __metadata("design:type", String)
    ], Problem.prototype, "vjudge_config");
    Problem = Problem_1 = __decorate([
        TypeORM.Entity()
    ], Problem);
    return Problem;
}(common_1["default"]));
exports["default"] = Problem;
//# sourceMappingURL=problem.js.map
