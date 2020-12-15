const fs = require("fs");
const path = require("path");
const luamin = require("luamin");

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

            var original = luaparse.ast["callExpression"];

            luaparse.ast["callExpression"] = function() {
                var node = original.apply(null, arguments);
                //console.log("hmm");console.dir(node);
                if (node.base.type == "Identifier" && node.base.name == "require") {
                    let first_arg = node.arguments[0];
                    if (first_arg.type != "StringLiteral") throw `invalid require statement: expected require() argument of type StringLiteral, got ${first_arg.type}`;

                    let required = get_required(script.baseDir, first_arg.value);
                    if (required == null) throw `invalid require statement: module "${first_arg.value}" was not found`;
                    if (this.debug) console.log(`found module in ${required.path}`)

                    // call recursive
                    var module_id = recurseResolve(required, false);
                    if (this.debug) console.log(`got back id of ${module_id} (resolving for ${script.path})`)

                    //replace ast to point to new module
                    /*node = {
                        "type": "IndexExpression",
                        "base": {
                          "type": "Identifier",
                          "name": "__OL__required",
                          "isLocal": true
                        },
                        "index": {
                          "type": "NumericLiteral",
                          "value": module_id,
                          "raw": module_id.toString()
                        }
                      }*/
                    node = {
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
                    };

                }
                return node;
            };

            var thisModuleId = ++currModuleId;
            modulesIds[script.path] = thisModuleId;
            if (this.debug) console.dir(modulesIds)

            if (this.debug) console.log("!!!!!! parsing ast for " + script.path + ` (id ${thisModuleId})`)
            //try {
            var ast = luaparse.parse(script.contents, { encodingMode: 'x-user-defined', scope: true });
            //}catch (err){ console.log(err) }

            if (this.debug) console.log("-----finished parse ast for " + script.path + ` (id ${thisModuleId})`)

            if (is_entry) {
                mainAst = ast;
            } else {
                modulesAst[thisModuleId] = ast;
                return thisModuleId;
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

        return luamin.minify(finalAst);
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
        var module_path = require.resolve(module, {
            paths: [path.join(process.cwd(), "node_modules")]
        });
        if (!module_path)
            return null;

        module_path = path.dirname(module_path);

        var pkgPath = path.resolve(module_path, "package.json");
        var pkgCfg = require(pkgPath);
        if (!pkgCfg)
            return null;  // package.json not found

        if (!pkgCfg.onelua || !pkgCfg.onelua.main)
            return null;  // package.json found, but no onelua instructions / entry file

        script_path = path.resolve(module_path, pkgCfg.onelua.main);
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
                "type": "TableKey",
                "key": {
                    "type": "NumericLiteral",
                    "value": key,
                    "raw": key.toString()
                },
                "value": {
                    "type": "FunctionDeclaration",
                    "identifier": null,
                    "isLocal": false,
                    "parameters": [],
                    "body": ast
                }
            };
        }
        var fields = [];

        Object.keys(modulesAst).forEach((id) => {
            fields.push(createRequireDef(id, modulesAst[id].body));
            finalAst.globals.push(...modulesAst[id].globals);  // extend globals
        });

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
                    "fields": fields
                }
            ]
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
