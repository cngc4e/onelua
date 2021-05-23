#!/usr/bin/env node

'use strict'

const fs = require("fs");
const path = require("path");
const { ArgumentParser } = require("argparse");
const { performance } = require("perf_hooks");
const onelua = require("./onelua.js");

function cli() {
    /* Parse args */
    const parser = new ArgumentParser({
        description: 'Argparse example',
        add_help: true
    });
    parser.add_argument('source', { help: "Path to the Lua project or entry point Lua file" });
    parser.add_argument('-o', '--output', { help: "Path to the output Lua file" });
    parser.add_argument('--debug', { help: "Turn on debugging logs", action: 'store_true' });
    parser.add_argument('--no-minify', { help: "Turn off minified output", action: 'store_true' });
    parser.add_argument('--prepend-meta', { help: "Prepend the name & date-time generated", action: 'store_true' });

    const args = parser.parse_args();

    var outputFile = args.output;
    if (!outputFile) {
        var pkgPath = path.resolve(args.source, "package.json");
        outputFile = pkgCfg.onelua.output;
        if (!outputFile) {
            console.log(`Error: no output file was specified in package.json)`);
            return 1;
        }
    }

    var time_start = performance.now();

    var output = null;
    try {
        output = onelua.process(
            path.resolve(args.source),
            { debug: args.debug, minify: !args.no_minify }
        );
    } catch (e) {
        console.log(`Error occurred while processing:\n${e}`);
        return 1;
    }

    if (args.prepend_meta) {
        let name = path.basename(outputFile);
        let time = new Date().toUTCString();
        output = `--[[\n    ${name}\n    Generated on ${time}\n]]--\n` + output;
    }

    try {
        fs.writeFileSync(outputFile, output);
    } catch (err) {
        console.error(`An error occurred while trying to write to ${outputFile}`)
        if (err) console.error(err);
        return 1;
    }

    var time_end = performance.now();
    var seconds_taken = ((time_end - time_start) / 1000).toFixed(2);

    console.log(`> Wrote file to ${path.resolve(outputFile)}\nBuild successful! (${seconds_taken}s)`)

    return 0;
}

if (cli() != 0)
    process.exit(1);
