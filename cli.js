#!/usr/bin/env node

'use strict'

const fs = require("fs");
const path = require("path");
const { ArgumentParser } = require("argparse");
const onelua = require("./onelua.js");

function cli() {
    /* Parse args */
    const parser = new ArgumentParser({
        description: 'Argparse example',
        add_help: true
    });
    parser.add_argument('source', { help: "Path to the Lua project or entry point Lua file" })
    parser.add_argument('-o', '--output', { help: "Path to the output Lua file" })

    const args = parser.parse_args();

    if (!fs.existsSync(args.source)) {
        console.log(`Error: entry point Lua source file not found (${args.source})`);
        return 1;
    }

    var entryFile = null;
    var outputFile = args.output;
    if (fs.lstatSync(args.source).isDirectory()) {
        var pkgPath = path.resolve(args.source, "package.json");
        var pkgCfg = require(pkgPath);
        if (!pkgCfg) {
            console.log(`Error: directory specified, but package.json not found (${args.source})`);
            return 1;
        }

        if (!pkgCfg.onelua) {
            console.log(`Error: package.json found, but has no onelua build instructions`);
            return 1;
        }

        entryFile = pkgCfg.onelua.main;
        if (!entryFile) {
            console.log(`Error: no main file was specified in package.json)`);
            return 1;
        }

        if (!outputFile) {
            outputFile = pkgCfg.onelua.output;
            if (!outputFile) {
                console.log(`Error: no output file was specified in package.json)`);
                return 1;
            }
        }

    } else {
        entryFile = args.source;
    }

    var output = onelua.process(entryFile);

    fs.writeFile(outputFile, output, (err) => {
        if (err) return console.log(err);
    });

    return 0;
}

if (cli() != 0)
    process.exit(1);
