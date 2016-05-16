"use strict";
var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var firmament_yargs_1 = require('firmament-yargs');
var firmament_docker_1 = require("firmament-docker");
var log = require('jsnlog').JL();
var async = require('async');
var positive = require('positive');
var _ = require('lodash');
var MakeCommand = (function (_super) {
    __extends(MakeCommand, _super);
    function MakeCommand() {
        _super.call(this);
        this.firmamentDocker = new firmament_docker_1.FirmamentDockerImpl();
        this.buildCommandTree();
    }
    MakeCommand.prototype.buildCommandTree = function () {
        this.aliases = ['make', 'm'];
        this.command = '<subCommand>';
        this.commandDesc = 'Support for building Docker container clusters';
        this.pushBuildCommand();
        this.pushTemplateCommand();
    };
    ;
    MakeCommand.prototype.pushTemplateCommand = function () {
        var _this = this;
        var templateCommand = new firmament_yargs_1.CommandImpl();
        templateCommand.aliases = ['template', 't'];
        templateCommand.commandDesc = 'Create a template JSON spec for a container cluster';
        templateCommand.options = {
            output: {
                alias: 'o',
                default: MakeCommand.defaultConfigFilename,
                type: 'string',
                desc: 'Name the output JSON file'
            },
            full: {
                alias: 'f',
                boolean: true,
                default: false,
                desc: 'Create a full JSON template with all Docker options set to reasonable defaults'
            }
        };
        templateCommand.handler = function (argv) { return _this.makeTemplate(argv); };
        this.subCommands.push(templateCommand);
    };
    ;
    MakeCommand.prototype.pushBuildCommand = function () {
        var _this = this;
        var buildCommand = new firmament_yargs_1.CommandImpl();
        buildCommand.aliases = ['build', 'b'];
        buildCommand.commandDesc = 'Build Docker containers based on JSON spec';
        buildCommand.options = {
            verbose: {
                alias: 'v',
                default: false,
                type: 'boolean',
                desc: 'Name the config JSON file'
            },
            input: {
                alias: 'i',
                default: MakeCommand.defaultConfigFilename,
                type: 'string',
                desc: 'Name the config JSON file'
            }
        };
        buildCommand.handler = function (argv) { return _this.buildTemplate(argv); };
        this.subCommands.push(buildCommand);
    };
    ;
    MakeCommand.prototype.buildTemplate = function (argv) {
        var fullInputPath = MakeCommand.getJsonConfigFilePath(argv.input);
        console.log("Constructing Docker containers described in: '" + fullInputPath + "'");
        var jsonFile = require('jsonfile');
        var containerDescriptors = jsonFile.readFileSync(fullInputPath);
        this.processContainerConfigs(containerDescriptors);
    };
    MakeCommand.prototype.makeTemplate = function (argv) {
        var fullOutputPath = MakeCommand.getJsonConfigFilePath(argv.output);
        var fs = require('fs');
        if (fs.existsSync(fullOutputPath)) {
            if (positive("Config file '" + fullOutputPath + "' already exists. Overwrite? [Y/n] ", true)) {
                MakeCommand.writeJsonTemplateFile(fullOutputPath, argv.full);
            }
            else {
                console.log('Canceling JSON template creation!');
            }
        }
        else {
            MakeCommand.writeJsonTemplateFile(fullOutputPath, argv.full);
        }
        this.processExit();
    };
    MakeCommand.getJsonConfigFilePath = function (filename) {
        var path = require('path');
        var cwd = process.cwd();
        var regex = new RegExp('(.*)\\' + MakeCommand.jsonFileExtension + '$', 'i');
        if (regex.test(filename)) {
            filename = filename.replace(regex, '$1' + MakeCommand.jsonFileExtension);
        }
        else {
            filename = filename + MakeCommand.jsonFileExtension;
        }
        return path.resolve(cwd, filename);
    };
    MakeCommand.prototype.processContainerConfigs = function (containerConfigs) {
        var _this = this;
        var self = this;
        var containerConfigsByImageName = {};
        containerConfigs.forEach(function (containerConfig) {
            containerConfigsByImageName[containerConfig.Image] = containerConfig;
        });
        async.waterfall([
            function (cb) {
                _this.firmamentDocker.removeContainers(containerConfigs.map(function (containerConfig) { return containerConfig.name; }), cb);
            },
            function (containerRemoveResults, cb) {
                _this.firmamentDocker.listImages(false, function (err, images) {
                    if (self.callbackIfError(cb, err)) {
                        return;
                    }
                    var repoTags = {};
                    images.forEach(function (dockerImage) {
                        repoTags[dockerImage.RepoTags[0]] = true;
                    });
                    var missingImageNames = [];
                    containerConfigs.forEach(function (containerConfig) {
                        if (!repoTags[containerConfig.Image]) {
                            missingImageNames.push(containerConfig.Image);
                        }
                    });
                    cb(null, _.uniq(missingImageNames));
                });
            },
            function (missingImageNames, cb) {
                async.mapSeries(missingImageNames, function (missingImageName, cb) {
                    _this.firmamentDocker.pullImage(missingImageName, function (taskId, status, current, total) {
                        MakeCommand.progressBar.showProgressForTask(taskId, status, current, total);
                    }, function (err) {
                        cb(null, err ? missingImageName : null);
                    });
                }, function (err, missingImageNames) {
                    if (self.callbackIfError(cb, err)) {
                        return;
                    }
                    cb(null, missingImageNames.filter(function (missingImageName) { return !!missingImageName; }));
                });
            },
            function (missingImageNames, cb) {
                async.mapSeries(missingImageNames, function (missingImageName, cb) {
                    var containerConfig = containerConfigsByImageName[missingImageName];
                    var path = require('path');
                    var cwd = process.cwd();
                    var dockerFilePath = path.join(cwd, containerConfig.DockerFilePath);
                    var dockerImageName = containerConfig.Image;
                    _this.firmamentDocker.buildDockerFile(dockerFilePath, dockerImageName, function (taskId, status, current, total) {
                        MakeCommand.progressBar.showProgressForTask(taskId, status, current, total);
                    }, function (err) {
                        cb(null, err
                            ? new Error('Unable to build Dockerfile at "' + dockerFilePath + '" because: ' + err.message)
                            : null);
                    });
                }, function (err, errors) {
                    if (self.callbackIfError(cb, err)) {
                        return;
                    }
                    errors = errors.filter(function (error) { return !!error; });
                    cb(self.logErrors(errors).length ? new Error() : null, errors);
                });
            },
            function (errs, cb) {
                try {
                    var sortedContainerConfigs_1 = self.containerDependencySort(containerConfigs);
                    async.mapSeries(sortedContainerConfigs_1, function (containerConfig, cb) {
                        _this.firmamentDocker.createContainer(containerConfig, function (err, container) {
                            self.logAndCallback('Container "' + containerConfig.name + '" created.', cb, err, container);
                        });
                    }, function (err, containers) {
                        if (self.callbackIfError(cb, err)) {
                            return;
                        }
                        var sortedContainerNames = sortedContainerConfigs_1.map(function (containerConfig) { return containerConfig.name; });
                        _this.firmamentDocker.startOrStopContainers(sortedContainerNames, true, function () {
                            cb(null, null);
                        });
                    });
                }
                catch (err) {
                    self.callbackIfError(cb, err);
                }
            },
            function deployExpressApps(errs, cb) {
                async.mapSeries(containerConfigs, function (containerConfig, cb) {
                    async.mapSeries(containerConfig.ExpressApps || [], function (expressApp, cb) {
                        async.series([
                            function (cb) {
                                var cwd = process.cwd();
                                expressApp.GitCloneFolder = cwd + '/' + expressApp.ServiceName + (new Date()).getTime();
                                self.gitClone(expressApp.GitUrl, expressApp.GitSrcBranchName, expressApp.GitCloneFolder, function (err) {
                                    self.logError(err);
                                    cb(null, null);
                                });
                            },
                            function (cb) {
                                async.mapSeries(expressApp.Scripts || [], function (script, cb) {
                                    var cwd = expressApp.GitCloneFolder + '/' + script.RelativeWorkingDir;
                                    self.spawnShellCommand(script.Command, script.Args, { cwd: cwd, stdio: null }, cb);
                                }, function (err, results) {
                                    cb(null, null);
                                });
                            },
                            function (cb) {
                                var cwd = expressApp.GitCloneFolder;
                                console.log('StrongLoop Building @ ' + cwd);
                                self.spawnShellCommand('slc', ['build'], { cwd: cwd, stdio: null }, cb);
                            },
                            function (cb) {
                                var cwd = expressApp.GitCloneFolder;
                                console.log('StrongLoop Deploying @ ' + cwd);
                                self.spawnShellCommand('slc', ['deploy', expressApp.StrongLoopServerUrl], { cwd: cwd, stdio: null }, cb);
                            }
                        ], function (err, results) {
                            cb(null, null);
                        });
                    }, function (err, results) {
                        cb(null, null);
                    });
                }, function (err, results) {
                    cb(null, null);
                });
            }
        ], function (err, results) {
            self.processExit();
        });
    };
    MakeCommand.writeJsonTemplateFile = function (fullOutputPath, writeFullTemplate) {
        console.log("Writing JSON template file '" + fullOutputPath + "' ...");
        var objectToWrite = writeFullTemplate
            ? firmament_docker_1.DockerDescriptors.dockerContainerDefaultTemplate
            : firmament_docker_1.DockerDescriptors.dockerContainerConfigTemplate;
        var jsonFile = require('jsonfile');
        jsonFile.spaces = 2;
        jsonFile.writeFileSync(fullOutputPath, objectToWrite);
    };
    MakeCommand.prototype.containerDependencySort = function (containerConfigs) {
        var sortedContainerConfigs = [];
        var objectToSort = {};
        var containerConfigByNameMap = {};
        containerConfigs.forEach(function (containerConfig) {
            if (containerConfigByNameMap[containerConfig.name]) {
                log.fatal('Same name is used by more than one container.');
            }
            containerConfigByNameMap[containerConfig.name] = containerConfig;
            var dependencies = [];
            if (containerConfig.HostConfig && containerConfig.HostConfig.Links) {
                containerConfig.HostConfig.Links.forEach(function (link) {
                    var linkName = link.split(':')[0];
                    dependencies.push(linkName);
                });
            }
            objectToSort[containerConfig.name] = dependencies;
        });
        var sortedContainerNames = this.topologicalDependencySort(objectToSort);
        sortedContainerNames.forEach(function (sortedContainerName) {
            sortedContainerConfigs.push(containerConfigByNameMap[sortedContainerName]);
        });
        return sortedContainerConfigs;
    };
    MakeCommand.prototype.topologicalDependencySort = function (graph) {
        var sorted = [], visited = {};
        try {
            Object.keys(graph).forEach(function visit(name, ancestors) {
                if (visited[name]) {
                    return;
                }
                if (!Array.isArray(ancestors)) {
                    ancestors = [];
                }
                ancestors.push(name);
                visited[name] = true;
                var deps = graph[name];
                deps.forEach(function (dep) {
                    if (ancestors.indexOf(dep) >= 0) {
                        log.fatal('Circular dependency "' + dep + '" is required by "' + name + '": ' + ancestors.join(' -> '));
                    }
                    visit(dep, ancestors.slice(0));
                });
                sorted.push(name);
            });
        }
        catch (ex) {
            throw new Error('Linked container dependency sort failed. You are probably trying to link to an unknown container.');
        }
        return sorted;
    };
    MakeCommand.prototype.gitClone = function (gitUrl, gitBranch, localFolder, cb) {
        this.spawnShellCommand('git', ['clone', '-b', gitBranch, '--single-branch', gitUrl, localFolder], null, cb);
    };
    MakeCommand.defaultConfigFilename = 'firmament.json';
    MakeCommand.jsonFileExtension = '.json';
    MakeCommand.progressBar = new firmament_yargs_1.ProgressBarImpl();
    return MakeCommand;
}(firmament_yargs_1.CommandImpl));
exports.MakeCommand = MakeCommand;
//# sourceMappingURL=makeCommand.js.map