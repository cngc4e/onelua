const fs = require("fs");
const path = require("path");
const luamin = require("luamin");
const luaprint = require("./luaprint");

class LuaScript {
    constructor(path_absol) {
        this.path = path_absol;
        this.baseDir = path.dirname(path_absol);
    }

    get contents() {
        return fs.readFileSync(this.path, 'utf-8');
    }

    exists() {
        return fs.existsSync(this.path);
    }
}

class OLProcessor {
    constructor(entry, options) {
        this.debug = options.debug;
        this.minify = options.minify;
        this.entryScript = new LuaScript(path.resolve(entry));

        if (!this.entryScript.exists()) throw "Entry script doesn't exist!";
    }

    process() {
        var modulesIds = {};  /* path: id */
        var modulesAst = {};  /* id: ast */
        var mainAst = null;

        var currModuleId = 0;

        var recurseResolve = (script, is_entry) => {
            if (script.path in modulesIds) {
                /* already resolved */
                if (this.debug) console.log("> already resolved .")
                return modulesIds[script.path];
            }

            /* delete luaparse cache */
            require("decache")("luaparse");
            const luaparse = require("luaparse");

            var get_required = (base_dir, module) => this.#getRequiredModule(base_dir, module);  // expose function to luaparse

            var new_astnode = (module) => {
                let required = get_required(script.baseDir, module);
                if (required == null)
                    throw `Invalid require: module "${module}" was not found in ${script.path}:${node.base.loc.start.line}`;

                if (this.debug) console.log(`found module in ${required.path}`);

                // call recursive
                var module_id = recurseResolve(required, false);
                if (this.debug) console.log(`got back id of ${module_id} (resolving for ${script.path})`);

                return {
                    "type": "CallExpression",
                    "base": {
                        "type": "Identifier",
                        "name": "__OL__require",
                        "isLocal": true
                    },
                    "arguments": [
                        {
                            "type": "NumericLiteral",
                            "value": module_id,
                            "raw": module_id.toString()
                        }
                    ]
                }
            }

            var originalStringCall = luaparse.ast["stringCallExpression"];
            luaparse.ast["stringCallExpression"] = function () {
                var node = originalStringCall.apply(null, arguments);
                if (node.base.type == "Identifier" && node.base.name == "require") {
                    //console.log(require("util").inspect(node, {showHidden: false, depth: null}))
                    let arg = node.argument;

                    // replace ast to point to new module
                    node = new_astnode(arg.value);
                }
                return node;
            }

            var originalCall = luaparse.ast["callExpression"];
            luaparse.ast["callExpression"] = function () {
                var node = originalCall.apply(null, arguments);
                if (node.base.type == "Identifier" && node.base.name == "require") {
                    //console.log(require("util").inspect(node, {showHidden: false, depth: null}))
                    let first_arg = node.arguments[0];
                    if (first_arg.type != "StringLiteral") throw `Invalid require: expected require() argument of type StringLiteral, got ${first_arg.type}`;

                    // replace ast to point to new module
                    node = new_astnode(first_arg.value);
                }
                return node;
            };

            if (this.debug) console.log("!!!!!! parsing ast for " + script.path)
            //try {
            var ast = luaparse.parse(script.contents, {
                encodingMode: 'x-user-defined',
                scope: true,
                comments: true,
                locations: true
            });
            //console.log(require("util").inspect(ast, {depth:4}))
            //}catch (err){ console.log(err) }

            if (this.debug) console.log("-----finished parse ast for " + script.path)

            if (is_entry) {
                mainAst = ast;
            } else {
                currModuleId++;
                modulesIds[script.path] = currModuleId;
                //if (this.debug) console.dir(modulesIds)
                if (this.debug) console.log("! The module '" + script.path + `' was resolved with id: ${currModuleId}`)

                modulesAst[currModuleId] = ast;
                return currModuleId;
            }
        }

        recurseResolve(this.entryScript, true);

        // merge the asts finally
        /*Object.keys(modulesAst).forEach((key) => {
            //console.dir(modulesAst[key]);
        });*/

        if (this.debug) {
            console.log("MODULESast:"); console.dir(modulesAst);
            console.log("MAINast:"); console.dir(mainAst);
        }

        var finalAst = this.#createFinalAst(modulesIds, modulesAst, mainAst);

        return this.minify ? luamin.minify(finalAst) : luaprint(finalAst);
    }

    /* Get the associated LuaScript from this context */
    #getRequiredModule(base_dir, module) {
        /* first convert . to / */
        module = module.replace(/\./g, "/");

        var script_path = null;
        if (this.debug) console.log(module + ".lua")

        /* next, find the module relative to the baseDir */
        script_path = path.join(base_dir, module + ".lua");
        if (fs.existsSync(script_path))
            return new LuaScript(script_path);

        /* then find the module relative to the entry dir */
        var entry_dir = this.entryScript.baseDir;
        script_path = path.join(entry_dir, module + ".lua");
        if (fs.existsSync(script_path))
            return new LuaScript(script_path);

        /* finally, find the module installed with npm */
        //console.dir(require.resolve.paths(module))
        var pkg_path = null;
        try {
            pkg_path = require.resolve(module + "/package.json", {
                paths: [path.join(process.cwd(), "node_modules")]
            });
        } catch (e) { }
        if (!pkg_path)
            return null;

        var module_path = path.dirname(pkg_path);

        var pkg_cfg = require(pkg_path);
        if (!pkg_cfg)
            return null;  // package.json not found

        if (!pkg_cfg.onelua || !pkg_cfg.onelua.main)
            return null;  // package.json found, but no onelua instructions / entry file

        script_path = path.resolve(module_path, pkg_cfg.onelua.main);
        if (fs.existsSync(script_path))
            return new LuaScript(script_path);

        return null;
    }

    #createFinalAst(modulesIds, modulesAst, mainAst) {
        var finalAst = {
            "type": "Chunk",
            "body": [
                {
                    "type": "LocalStatement",
                    "variables": [
                        {
                            "type": "Identifier",
                            "name": "__OL__require",
                            "isLocal": true
                        }
                    ],
                    "init": []
                }
            ],
            "comments": [],
            "globals": []
        };

        /* ast utils */
        var createRequireDef = (key, ast) => {
            return {
                "type": "AssignmentStatement",
                "variables": [
                    {
                        "type": "IndexExpression",
                        "base": {
                            "type": "Identifier",
                            "name": "__OL__packages",
                            "isLocal": true
                        },
                        "index": {
                            "type": "NumericLiteral",
                            "value": key,
                            "raw": key.toString()
                        }
                    }
                ],
                "init": [
                    {
                        "type": "FunctionDeclaration",
                        "identifier": null,
                        "isLocal": false,
                        "parameters": [

                        ],
                        "body": ast
                    }
                ]
            }
        }

        /* define packages */
        finalAst.body.push({
            "type": "LocalStatement",
            "variables": [
                {
                    "type": "Identifier",
                    "name": "__OL__packages",
                    "isLocal": true
                }
            ],
            "init": [
                {
                    "type": "TableConstructorExpression",
                    "fields": []
                }
            ]
        });

        Object.keys(modulesAst).forEach((id) => {
            finalAst.body.push(createRequireDef(id, modulesAst[id].body));
            finalAst.globals.push(...modulesAst[id].globals);  // extend globals
        });

        /* define One-lua require() function */
        finalAst.body.push({
            "type": "LocalStatement",
            "variables": [
                {
                    "type": "Identifier",
                    "name": "__OL__cached_packages",
                    "isLocal": true
                }
            ],
            "init": [
                {
                    "type": "TableConstructorExpression",
                    "fields": []
                }
            ]
        });
        finalAst.body.push({
            "type": "AssignmentStatement",
            "variables": [
                {
                    "type": "Identifier",
                    "name": "__OL__require",
                    "isLocal": true
                }
            ],
            "init": [
                {
                    "type": "FunctionDeclaration",
                    "identifier": null,
                    "isLocal": false,
                    "parameters": [
                        {
                            "type": "Identifier",
                            "name": "id",
                            "isLocal": true
                        }
                    ],
                    "body": [
                        {
                            "type": "IfStatement",
                            "clauses": [
                                {
                                    "type": "IfClause",
                                    "condition": {
                                        "type": "IndexExpression",
                                        "base": {
                                            "type": "Identifier",
                                            "name": "__OL__cached_packages",
                                            "isLocal": true
                                        },
                                        "index": {
                                            "type": "Identifier",
                                            "name": "id",
                                            "isLocal": true
                                        }
                                    },
                                    "body": [
                                        {
                                            "type": "ReturnStatement",
                                            "arguments": [
                                                {
                                                    "type": "IndexExpression",
                                                    "base": {
                                                        "type": "Identifier",
                                                        "name": "__OL__cached_packages",
                                                        "isLocal": true
                                                    },
                                                    "index": {
                                                        "type": "Identifier",
                                                        "name": "id",
                                                        "isLocal": true
                                                    }
                                                }
                                            ]
                                        }
                                    ]
                                }
                            ]
                        },
                        {
                            "type": "LocalStatement",
                            "variables": [
                                {
                                    "type": "Identifier",
                                    "name": "package",
                                    "isLocal": true
                                }
                            ],
                            "init": [
                                {
                                    "type": "CallExpression",
                                    "base": {
                                        "type": "IndexExpression",
                                        "base": {
                                            "type": "Identifier",
                                            "name": "__OL__packages",
                                            "isLocal": true
                                        },
                                        "index": {
                                            "type": "Identifier",
                                            "name": "id",
                                            "isLocal": true
                                        }
                                    },
                                    "arguments": []
                                }
                            ]
                        },
                        {
                            "type": "AssignmentStatement",
                            "variables": [
                                {
                                    "type": "IndexExpression",
                                    "base": {
                                        "type": "Identifier",
                                        "name": "__OL__cached_packages",
                                        "isLocal": true
                                    },
                                    "index": {
                                        "type": "Identifier",
                                        "name": "id",
                                        "isLocal": true
                                    }
                                }
                            ],
                            "init": [
                                {
                                    "type": "Identifier",
                                    "name": "package",
                                    "isLocal": true
                                }
                            ]
                        },
                        {
                            "type": "ReturnStatement",
                            "arguments": [
                                {
                                    "type": "Identifier",
                                    "name": "package",
                                    "isLocal": true
                                }
                            ]
                        }
                    ]
                }
            ]
        });

        /* add main */
        finalAst.body.push(...mainAst.body);  // extend body
        finalAst.globals.push(...mainAst.globals);  // extend globals

        if (this.debug) console.dir(JSON.stringify(finalAst))

        return finalAst;
    }
};

module.exports = {
    process: (entry, options) => {
        return new OLProcessor(entry, options).process();
    },
};
