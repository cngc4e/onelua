/*
 * luaprint.js
 *
 * "Beautify" Lua source or luaparse compatible AST.
 */

const luaparse = require("luaparse");

var PRECEDENCE = {
    'or': 1,
    'and': 2,
    '<': 3, '>': 3, '<=': 3, '>=': 3, '~=': 3, '==': 3,
    '..': 5,
    '+': 6, '-': 6, // binary -
    '*': 7, '/': 7, '%': 7,
    'unarynot': 8, 'unary#': 8, 'unary-': 8, // unary -
    '^': 10
};

var eachItem = function(array, fn) {
    var index = -1;
    var length = array.length;
    var max = length - 1;
    while (++index < length) {
        fn(array[index], index < max);
    }
};

var joinStatements = function(a, b, separator) {
    separator || (separator = ' ');

    var lastCharA = a.slice(-1);
    var firstCharB = b.charAt(0);

    if (lastCharA == '' || firstCharB == '') {
        return a + b;
    }
    return a + separator + b;
};

var formatStatementList = function(body) {
    var result = '';
    eachItem(body, function(statement) {
        result = joinStatements(result, formatStatement(statement), '\n' + INDENT.repeat(depth));
    });
    return result;
};

var formatBase = function(base) {
    var result = '';
    var type = base.type;
    var needsParens = base.inParens && (
        type == 'CallExpression' ||
        type == 'BinaryExpression' ||
        type == 'FunctionDeclaration' ||
        type == 'TableConstructorExpression' ||
        type == 'LogicalExpression' ||
        type == 'StringLiteral'
    );
    if (needsParens) {
        result += '(';
    }
    result += formatExpression(base);
    if (needsParens) {
        result += ')';
    }
    return result;
};

var depth = 0;
var INDENT = "    ";

var formatExpression = function(expression, options) {

    options = {
        'precedence': 0,
        'preserveIdentifiers': false,
        ...options
    };

    var result = '';
    var currentPrecedence;
    var associativity;
    var operator;

    var expressionType = expression.type;

    if (expressionType == 'Identifier') {

        result = expression.name;

    } else if (
        expressionType == 'StringLiteral' ||
        expressionType == 'NumericLiteral' ||
        expressionType == 'BooleanLiteral' ||
        expressionType == 'NilLiteral' ||
        expressionType == 'VarargLiteral'
    ) {

        result = expression.raw;

    } else if (
        expressionType == 'LogicalExpression' ||
        expressionType == 'BinaryExpression'
    ) {

        // If an expression with precedence x
        // contains an expression with precedence < x,
        // the inner expression must be wrapped in parens.
        operator = expression.operator;
        currentPrecedence = PRECEDENCE[operator];
        associativity = 'left';

        result = formatExpression(expression.left, {
            'precedence': currentPrecedence,
            'direction': 'left',
            'parent': operator
        });
        result = joinStatements(result, operator);
        result = joinStatements(result, formatExpression(expression.right, {
            'precedence': currentPrecedence,
            'direction': 'right',
            'parent': operator
        }));

        if (operator == '^' || operator == '..') {
            associativity = "right";
        }

        if (
            currentPrecedence < options.precedence ||
            (
                currentPrecedence == options.precedence &&
                associativity != options.direction &&
                options.parent != '+' &&
                !(options.parent == '*' && (operator == '/' || operator == '*'))
            )
        ) {
            // The most simple case here is that of
            // protecting the parentheses on the RHS of
            // `1 - (2 - 3)` but deleting them from `(1 - 2) - 3`.
            // This is generally the right thing to do. The
            // semantics of `+` are special however: `1 + (2 - 3)`
            // == `1 + 2 - 3`. `-` and `+` are the only two operators
            // who share their precedence level. `*` also can
            // commute in such a way with `/`, but not with `%`
            // (all three share a precedence). So we test for
            // all of these conditions and avoid emitting
            // parentheses in the cases where we don’t have to.
            result = '(' + result + ')';
        }

    } else if (expressionType == 'UnaryExpression') {

        operator = expression.operator;
        currentPrecedence = PRECEDENCE['unary' + operator];

        result = joinStatements(
            operator,
            formatExpression(expression.argument, {
                'precedence': currentPrecedence
            })
        );

        if (
            currentPrecedence < options.precedence &&
            // In principle, we should parenthesize the RHS of an
            // expression like `3^-2`, because `^` has higher precedence
            // than unary `-` according to the manual. But that is
            // misleading on the RHS of `^`, since the parser will
            // always try to find a unary operator regardless of
            // precedence.
            !(
                (options.parent == '^') &&
                options.direction == 'right'
            )
        ) {
            result = '(' + result + ')';
        }

    } else if (expressionType == 'CallExpression') {

        result = formatBase(expression.base) + '(';

        eachItem(expression.arguments, function(argument, needsComma) {
            result += formatExpression(argument);
            if (needsComma) {
                result += ', ';
            }
        });
        result += ')';

    } else if (expressionType == 'TableCallExpression') {

        result = formatExpression(expression.base) +
            formatExpression(expression.arguments);

    } else if (expressionType == 'StringCallExpression') {

        result = formatExpression(expression.base) +
            formatExpression(expression.argument);

    } else if (expressionType == 'IndexExpression') {

        result = formatBase(expression.base) + '[' +
            formatExpression(expression.index) + ']';

    } else if (expressionType == 'MemberExpression') {

        result = formatBase(expression.base) + expression.indexer +
            formatExpression(expression.identifier, {
                'preserveIdentifiers': true
            });

    } else if (expressionType == 'FunctionDeclaration') {

        result = 'function(';
        if (expression.parameters.length) {
            eachItem(expression.parameters, function(parameter, needsComma) {
                // `Identifier`s have a `name`, `VarargLiteral`s have a `value`
                result += parameter.name
                    ? parameter.name
                    : parameter.value;
                if (needsComma) {
                    result += ', ';
                }
            });
        }
        result += ')';
        depth++;
        result = joinStatements(result, formatStatementList(expression.body), '\n' + INDENT.repeat(depth));
        depth--;
        result = joinStatements(result, 'end', '\n' + INDENT.repeat(depth));

    } else if (expressionType == 'TableConstructorExpression') {
        if (expression.fields.length <= 0) {
            result = '{}'
        } else {
            result = '{\n';
            depth++;

            eachItem(expression.fields, function(field, needsComma) {
                result += INDENT.repeat(depth);
                if (field.type == 'TableKey') {
                    result += '[' + formatExpression(field.key) + '] = ' +
                        formatExpression(field.value);
                } else if (field.type == 'TableValue') {
                    result += formatExpression(field.value);
                } else { // at this point, `field.type == 'TableKeyString'`
                    result += formatExpression(field.key, {
                        // TODO: keep track of nested scopes (#18)
                        'preserveIdentifiers': true
                    }) + ' = ' + formatExpression(field.value);
                }
                if (needsComma) {
                    result += ',';
                }
                result += '\n';
            });

            depth--;
            result += INDENT.repeat(depth);
            result += '}';
        }
    } else {

        throw TypeError('Unknown expression type: `' + expressionType + '`');

    }

    return result;
};

var formatStatement = function(statement) {
    var result = '';
    var statementType = statement.type;

    if (statementType == 'AssignmentStatement') {

        // left-hand side
        eachItem(statement.variables, function(variable, needsComma) {
            result += formatExpression(variable);
            if (needsComma) {
                result += ', ';
            }
        });

        // right-hand side
        result += ' = ';
        eachItem(statement.init, function(init, needsComma) {
            result += formatExpression(init);
            if (needsComma) {
                result += ', ';
            }
        });

    } else if (statementType == 'LocalStatement') {

        result = 'local ';

        // left-hand side
        eachItem(statement.variables, function(variable, needsComma) {
            // Variables in a `LocalStatement` are always local, duh
            result += variable.name;
            if (needsComma) {
                result += ', ';
            }
        });

        // right-hand side
        if (statement.init.length) {
            result += ' = ';
            eachItem(statement.init, function(init, needsComma) {
                result += formatExpression(init);
                if (needsComma) {
                    result += ', ';
                }
            });
        }

    } else if (statementType == 'CallStatement') {

        result = formatExpression(statement.expression);

    } else if (statementType == 'IfStatement') {

        result = joinStatements(
            'if',
            formatExpression(statement.clauses[0].condition)
        );
        result = joinStatements(result, 'then');
        depth++;
        result = joinStatements(
            result,
            formatStatementList(statement.clauses[0].body),
            '\n' + INDENT.repeat(depth)
        );
        eachItem(statement.clauses.slice(1), function(clause) {
            depth--;
            if (clause.condition) {
                result = joinStatements(result, 'elseif', '\n' + INDENT.repeat(depth));
                result = joinStatements(result, formatExpression(clause.condition));
                result = joinStatements(result, 'then');
            } else {
                result = joinStatements(result, 'else', '\n' + INDENT.repeat(depth));
            }
            depth++;
            result = joinStatements(result, formatStatementList(clause.body), '\n' + INDENT.repeat(depth));
        });
        depth--;
        result = joinStatements(result, 'end', '\n' + INDENT.repeat(depth));

    } else if (statementType == 'WhileStatement') {

        result = joinStatements('while', formatExpression(statement.condition));
        depth++;
        result = joinStatements(result, 'do', '\n' + INDENT.repeat(depth));
        result = joinStatements(result, formatStatementList(statement.body), '\n' + INDENT.repeat(depth));
        depth--;
        result = joinStatements(result, 'end', '\n' + INDENT.repeat(depth));

    } else if (statementType == 'DoStatement') {

        depth++;
        result = joinStatements('do', formatStatementList(statement.body), '\n' + INDENT.repeat(depth));
        depth--;
        result = joinStatements(result, 'end', '\n' + INDENT.repeat(depth));

    } else if (statementType == 'ReturnStatement') {

        result = 'return';

        eachItem(statement.arguments, function(argument, needsComma) {
            result = joinStatements(result, formatExpression(argument));
            if (needsComma) {
                result += ',';
            }
        });

    } else if (statementType == 'BreakStatement') {

        result = 'break';

    } else if (statementType == 'RepeatStatement') {

        depth++;
        result = joinStatements('repeat', formatStatementList(statement.body), '\n' + INDENT.repeat(depth));
        depth--;
        result = joinStatements(result, 'until');
        result = joinStatements(result, formatExpression(statement.condition))

    } else if (statementType == 'FunctionDeclaration') {

        result += (statement.isLocal ? 'local ' : '') + 'function ';
        result += formatExpression(statement.identifier);
        result += '(';

        if (statement.parameters.length) {
            eachItem(statement.parameters, function(parameter, needsComma) {
                // `Identifier`s have a `name`, `VarargLiteral`s have a `value`
                result += parameter.name
                    ? parameter.name
                    : parameter.value;
                if (needsComma) {
                    result += ', ';
                }
            });
        }

        result += ')';
        depth++;
        result = joinStatements(result, formatStatementList(statement.body), '\n' + INDENT.repeat(depth));
        depth--;
        result = joinStatements(result, 'end', '\n' + INDENT.repeat(depth));

    } else if (statementType == 'ForGenericStatement') {
        // see also `ForNumericStatement`

        result = 'for ';

        eachItem(statement.variables, function(variable, needsComma) {
            // The variables in a `ForGenericStatement` are always local
            result += variable.name;
            if (needsComma) {
                result += ', ';
            }
        });

        result += ' in';

        eachItem(statement.iterators, function(iterator, needsComma) {
            result = joinStatements(result, formatExpression(iterator));
            if (needsComma) {
                result += ',';
            }
        });

        result = joinStatements(result, 'do');
        depth++;
        result = joinStatements(result, formatStatementList(statement.body), '\n' + INDENT.repeat(depth));
        depth--;
        result = joinStatements(result, 'end', '\n' + INDENT.repeat(depth));

    } else if (statementType == 'ForNumericStatement') {

        // The variables in a `ForNumericStatement` are always local
        result = 'for ' + statement.variable.name + ' = ';
        result += formatExpression(statement.start) + ', ' +
            formatExpression(statement.end);

        if (statement.step) {
            result += ', ' + formatExpression(statement.step);
        }

        result = joinStatements(result, 'do');
        depth++;
        result = joinStatements(result, formatStatementList(statement.body), '\n' + INDENT.repeat(depth));
        depth--;
        result = joinStatements(result, 'end', '\n' + INDENT.repeat(depth));

    } else if (statementType == 'LabelStatement') {

        // The identifier names in a `LabelStatement` can safely be renamed
        result = '::' + statement.label.name + '::';

    } else if (statementType == 'GotoStatement') {

        // The identifier names in a `GotoStatement` can safely be renamed
        result = 'goto ' + statement.label.name;

    } else {

        throw TypeError('Unknown statement type: `' + statementType + '`');

    }

    return result;
};


function luaprint(argument) {
    // `argument` can be a Lua code snippet (string)
    // or a luaparse-compatible AST (object)
    var ast = typeof argument == 'string'
        ? luaparse.parse(argument)
        : argument;

    return formatStatementList(ast.body) + '\n';

}

module.exports = luaprint;
