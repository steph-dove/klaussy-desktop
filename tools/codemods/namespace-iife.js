// jscodeshift codemod: take a `window.<NS> = (function(){ ... })();` IIFE and
// hoist every TOP-LEVEL function/var declared inside it onto a shared object
// `PR` (=== window.<NS>), rewriting every in-scope reference to `PR.<name>`.
// Scope-aware: a reference is only rewritten when its binding resolves to the
// IIFE's own scope, so shadowing params/locals and inner functions are left
// untouched. Strings and comments are never matched (we only touch Identifier
// AST nodes). Property keys / non-computed member accesses are skipped.
//
// Result shape:
//   window.<NS> = window.<NS> || {};
//   (function (PR) {
//     PR.foo = function () { ... PR.bar() ... };
//     PR.state = { ... };
//   })(window.<NS>);
//
// After this, the single namespaced file can be physically split: any set of
// `PR.x = ...` statements can move to a sibling `(function(PR){...})(window.<NS>)`
// file with zero further edits.
//
// Usage: jscodeshift -t namespace-iife.js <file> --namespace=PrReview [--prparam=PR]

module.exports = function (fileInfo, api, options) {
  const j = api.jscodeshift;
  const NS = options.namespace;
  const PR = options.prparam || 'PR';
  if (!NS) throw new Error('--namespace is required');

  const root = j(fileInfo.source);

  // Find the `window.<NS> = (function(){...})()` assignment.
  const assign = root.find(j.AssignmentExpression, (n) =>
    n.operator === '=' &&
    n.left.type === 'MemberExpression' &&
    n.left.object.type === 'Identifier' && n.left.object.name === 'window' &&
    n.left.property.type === 'Identifier' && n.left.property.name === NS &&
    n.right.type === 'CallExpression' &&
    (n.right.callee.type === 'FunctionExpression' || n.right.callee.type === 'ArrowFunctionExpression')
  );
  if (assign.size() !== 1) throw new Error(`expected exactly one 'window.${NS} = (function(){...})()' (found ${assign.size()})`);

  const assignPath = assign.paths()[0];
  const callExpr = assignPath.node.right;
  const wrapperFn = callExpr.callee;
  const bodyBlock = wrapperFn.body; // BlockStatement
  if (!bodyBlock || bodyBlock.type !== 'BlockStatement') throw new Error('wrapper has no block body');

  // The wrapper's scope, via a path to the function expression.
  const wrapperFnPath = assign.find(j.FunctionExpression).paths()[0]
    || assign.find(j.ArrowFunctionExpression).paths()[0];
  const wrapperScope = wrapperFnPath.scope;

  // Collect top-level declared names (function declarations + var/let/const
  // declarators directly in the wrapper body).
  const names = new Set();
  for (const stmt of bodyBlock.body) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id) names.add(stmt.id.name);
    else if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations) if (d.id.type === 'Identifier') names.add(d.id.name);
    }
  }
  if (names.size === 0) throw new Error('no top-level declarations found');

  // --- Rewrite references to PR.<name> (scope-aware). ---
  function isSkippablePosition(path) {
    const parent = path.parent.node;
    const node = path.node;
    // foo.NAME  (member property, non-computed) -> not a reference
    if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return true;
    // { NAME: ... } object key (non-shorthand) -> not a reference
    if (parent.type === 'Property' && parent.key === node && !parent.shorthand && !parent.computed) return true;
    if (parent.type === 'ObjectProperty' && parent.key === node && !parent.shorthand && !parent.computed) return true;
    // label positions
    if (parent.type === 'LabeledStatement' && parent.label === node) return true;
    if ((parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') && parent.label === node) return true;
    return false;
  }

  // Is this identifier path the *declaration id* of one of our top-level decls?
  function isOwnDeclarationId(path) {
    const parent = path.parent.node;
    if (parent.type === 'FunctionDeclaration' && parent.id === path.node) {
      return path.parent.parent.node === bodyBlock || bodyBlock.body.indexOf(parent) !== -1;
    }
    if (parent.type === 'VariableDeclarator' && parent.id === path.node) {
      // only when the declarator belongs to a top-level VariableDeclaration
      const declStmt = path.parent.parent.node; // VariableDeclaration
      return bodyBlock.body.indexOf(declStmt) !== -1;
    }
    return false;
  }

  root.find(j.Identifier).forEach((path) => {
    const name = path.node.name;
    if (!names.has(name)) return;
    if (isSkippablePosition(path)) return;
    if (isOwnDeclarationId(path)) return;
    // Shorthand object property { NAME } -> expand to { NAME: PR.NAME }
    const parent = path.parent.node;
    const isShorthandVal =
      (parent.type === 'Property' || parent.type === 'ObjectProperty') &&
      parent.shorthand && parent.value === path.node;
    // Scope check: only rewrite when the binding resolves to the wrapper scope.
    let scope = path.scope;
    const binding = scope ? scope.lookup(name) : null;
    if (binding !== wrapperScope) return; // shadowed local/param or not ours
    const member = j.memberExpression(j.identifier(PR), j.identifier(name));
    if (isShorthandVal) {
      parent.shorthand = false;
      parent.value = member;
    } else {
      j(path).replaceWith(member);
    }
  });

  // Carry recast/babel comment attachments from an original node onto the
  // node that replaces it, so the declaration->assignment rewrite doesn't drop
  // the (load-bearing) doc comments.
  function carryComments(from, to) {
    if (from.comments) to.comments = from.comments;
    if (from.leadingComments) to.leadingComments = from.leadingComments;
    if (from.trailingComments) to.trailingComments = from.trailingComments;
  }

  // --- Rewrite the top-level declarations into PR.<name> = ... assignments. ---
  const newBody = [];
  for (const stmt of bodyBlock.body) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id) {
      const fnExpr = j.functionExpression(null, stmt.params, stmt.body);
      fnExpr.async = stmt.async; fnExpr.generator = stmt.generator;
      const out = j.expressionStatement(
        j.assignmentExpression('=', j.memberExpression(j.identifier(PR), j.identifier(stmt.id.name)), fnExpr)
      );
      carryComments(stmt, out);
      newBody.push(out);
    } else if (stmt.type === 'VariableDeclaration') {
      let first = true;
      for (const d of stmt.declarations) {
        if (d.id.type !== 'Identifier') { newBody.push(stmt); continue; }
        const out = j.expressionStatement(
          j.assignmentExpression('=',
            j.memberExpression(j.identifier(PR), j.identifier(d.id.name)),
            d.init || j.identifier('undefined'))
        );
        // The whole declaration's leading comment belongs to the first slice.
        if (first) carryComments(stmt, out);
        first = false;
        newBody.push(out);
      }
    } else {
      newBody.push(stmt);
    }
  }
  bodyBlock.body = newBody;

  // --- Reshape the IIFE: window.NS = window.NS || {}; (function(PR){...})(window.NS); ---
  wrapperFn.params = [j.identifier(PR)];
  // Replace the whole `window.NS = (fn)()` statement with two statements.
  const assignStmtPath = assignPath.parent; // ExpressionStatement
  const winNs = () => j.memberExpression(j.identifier('window'), j.identifier(NS));
  const initStmt = j.expressionStatement(
    j.assignmentExpression('=', winNs(), j.logicalExpression('||', winNs(), j.objectExpression([])))
  );
  // Preserve the file-top doc comment that was attached to the original
  // `window.NS = (...)()` statement.
  carryComments(assignStmtPath.node, initStmt);
  // New call passes window.NS as PR.
  callExpr.arguments = [winNs()];
  const iifeStmt = j.expressionStatement(callExpr);
  j(assignStmtPath).replaceWith([initStmt, iifeStmt]);

  return root.toSource({ quote: 'single', lineTerminator: '\n' });
};
