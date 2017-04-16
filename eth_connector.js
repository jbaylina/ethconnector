/*jslint node: true */
"use strict";

var async = require('async');
var path = require('path');
var fs = require('fs');
var _ = require('lodash');
var solc = require('solc');
var Web3 = require('web3');
var TestRPC = require("ethereumjs-testrpc");
var ethClient = new EthClient();
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var asyncfunc = require('runethtx').asyncfunc;

module.exports = ethClient;

function EthClient() {
    this.web3= new Web3();
}

util.inherits(EthClient, EventEmitter);

EthClient.prototype.init = function init(provider, opts, _cb) {
    return asyncfunc((cb) => {
        if (typeof opts === "function") {
            cb =opts;
            opts = {};
        }
        var self = this;
        if (provider.toUpperCase() === "TESTRPC") {
            self.web3.setProvider(TestRPC.provider(opts));
        } else {
            self.web3 = new Web3(new Web3.providers.HttpProvider("http://localhost:8545"));
        }

        self.gasLimit = opts.gasLimit || 4000000;
        self.gasPrice = opts.gasPrice || self.web3.toWei(0.00000006);

        self.web3.eth.getAccounts(function(err, accounts) {
            if (err) return cb(err);
            self.accounts = accounts;
            self.emit('init');
            cb();
        });
    }, _cb);
};


EthClient.prototype.loadSol = function loadSol(file, imported, cb) {

    if (typeof imported === "function") {
        cb = imported;
        imported = {};
    }

    var src = "";

//    var file = path.resolve(path.join(__dirname, ".."), filename);
    if (imported[file]) {
        return cb(null, src);
    }

    imported[file] = true;
    fs.readFile(file, 'utf8' ,function(err, srcCode) {
        if (err) return cb(err);

        var r = /^import \"(.*)\";/gm;

        var arr = srcCode.match(r);

        srcCode = srcCode.replace(r, '');

        if (!arr) return cb(null, srcCode);

        async.eachSeries(arr, function(l, cb) {
            var r = /import \"(.*)\";/;
            var importfile = r.exec(l)[1];

            importfile = path.join(path.dirname(file), importfile);

            loadSol(importfile, imported, function(err, importSrc) {
                if (err) return cb(err);
                src = src + importSrc;
                cb();
            });
        }, function(err)  {
            if (err) return cb(err);
            src = src + "\n//File: " + file + "\n";
            src = src + srcCode;
            cb(null,src);
        });
    });
};

EthClient.prototype.applyConstants = function applyConstants(src, opts, cb) {

    var srcOut = src;

    _.each(opts, function(value, param) {
        var rule = new RegExp('constant ' + param + ' = (.*);','gm');
        var replacedText = 'constant ' + param + ' = ' + value + ';';

        srcOut = srcOut.replace(rule,replacedText);

    });

    async.setImmediate(function() {
        cb(null, srcOut);
    });
};

function fixErrorLines(src, errors) {
    var lines = src.split("\n");
    _.each(errors, function(error, idx) {
        var rErrPos = new RegExp('\:([0-9]+)\:([0-9]+)\:');
        var errPos = rErrPos.exec(error);
        var lineNum = errPos ? parseInt(errPos[1])-1 : -1;
        var found = false;
        var offset = 1;
        var rFile = new RegExp("//File: (.*)","");
        while ((!found)&&(offset <= lineNum)) {
            var fileInfo = rFile.exec(lines[lineNum - offset]);
            if (fileInfo) {
                errors[idx] = error.replace(rErrPos, fileInfo[1] + " :" + offset + ":" + errPos[2] + ":" );
                found = true;
            } else {
                offset += 1;
            }
        }
    });
}

EthClient.prototype.solCompile = function solCompile(src, cb) {
    var result = solc.compile(src, 1);
    async.setImmediate(function() {
        if (!result.contracts) {
            fixErrorLines(src, result.errors);
            return cb(result.errors);
        }
        cb(null, result.contracts);
    });
};

// Parameters:
// interface, code, accountIdx, value, constructor arguments . . ., cb
EthClient.prototype.deploy = function deploy(abi, code, account, value) {
    var self = this;
    var args = Array.prototype.slice.call(arguments, 4, arguments.length-1);
    var cb = arguments[arguments.length-1];

    if (typeof abi == "string") abi = JSON.parse(abi);

    if (typeof account == "number") account = self.accounts[account];

    args.push({
        from: account,
        value: value,
        data: code,
//        gas: 4712000
//        gas: 5500000
        gas: self.gasLimit,
        gasPrice: self.gasPrice
    });

    args.push(function (err, contract) {
        if (err) return cb(err);
        if (typeof contract.address != 'undefined') {
            cb(null, contract);
        }
    });

    var contract = self.web3.eth.contract(abi);
    contract.new.apply(contract, args);
};

EthClient.prototype.compile = function(sourceFile, destFile, opts, cb) {
    var self = this;
    if (typeof opts !== "object") {
        cb = opts;
        opts = {};
    }

    var compilationResult;
    var src;
    return async.series([
        function(cb) {
            self.loadSol(sourceFile, function(err, _src) {
                if (err) return cb(err);
                src = _src;
                cb();
            });
        },
        function(cb) {
            self.applyConstants(src, opts, function(err, _src) {
                if (err) return cb(err);
                src = _src;
                cb();
            });
        },
        function(cb) {
            self.solCompile(src, function(err, result) {
                if (err) return cb(err);
                compilationResult = result;
                cb();
            });
        },
        function(cb) {
            var S = "";
            S += "/* This is an autogenerated file. DO NOT EDIT MANUALLY */\n\n";

            _.each(compilationResult, function(contract, contractName) {
                if (contractName[0] === ":") contractName = contractName.substr(1);
                var abi = JSON.parse(contract.interface);
                var byteCode = contract.bytecode;
                S += "exports." + contractName + "Abi = "+JSON.stringify(abi) +";\n";
                S += "exports." + contractName + "ByteCode = \"0x"+byteCode + "\";\n";
            });

            fs.writeFile(destFile, S, cb);
        }
    ], cb);
};


EthClient.prototype.delay = function(secs, _cb) {
    var self = this;
    return asyncfunc((cb) => {
        send("evm_mine", function(err, result) {
            if (err) return cb(err);

            send("evm_increaseTime", [secs], function(err, result) {
                if (err) return cb(err);

          // Mine a block so new time is recorded.
                send("evm_mine", function(err, result) {
                    if (err) return cb(err);
                    cb();
                });
            });
        });

            // CALL a low level rpc
        function send(method, params, callback) {
            if (typeof params === "function") {
                callback = params;
                params = [];
            }

            self.web3.currentProvider.sendAsync({
                jsonrpc: "2.0",
                method,
                params: params || [],
                id: new Date().getTime(),
            }, callback);
        }

        function mineTx() {

        }
    }, _cb);
}
